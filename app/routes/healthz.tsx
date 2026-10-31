/**
 * The liveness endpoint the platform polls.
 *
 * Railway holds a deploy at "deploying" until this answers, then routes traffic to it —
 * so it decides whether a broken release replaces a working one. That makes what it
 * checks a real decision rather than a formality.
 *
 * **It checks the datastores, not just the process.** A web process that is listening but
 * cannot reach Postgres serves every merchant an error page, and a healthcheck that only
 * proved the port was open would happily promote it over the release that worked. Both
 * checks are cheap — a `SELECT 1` and a Redis `PING` — and they are the two dependencies
 * whose absence makes the app useless rather than degraded.
 *
 * **Redis missing is degraded, not dead.** The queue falls back to running jobs inline, so
 * a shop can still preview and apply; scheduling is what suffers. That is reported in the
 * body and deliberately does not fail the check, because taking the web service down for
 * it would turn a partial outage into a total one.
 *
 * **It also reports the scheduler, and deliberately does not fail on it.** The worker is a
 * separate service, so the web process being healthy says nothing about whether anything
 * is ticking — and until this reported it, "is the worker running?" could only be answered
 * by someone with database access. That is the wrong shape for the one condition that
 * detects a dead worker: `scheduler-stopped` is detected by *absence*, which needs an
 * external reader. This is that reader.
 *
 * Failing the check on it would be worse than useless: it would take the web service down
 * because a *different* service stopped, turning "scheduled reverts are late" into "the
 * app is gone".
 *
 * **It reports whether this deployment can send mail, and does not fail on that either.**
 * Without a mail provider, Contact support cannot send and merchants are shown the support
 * address instead (#758). That is a deployment missing a required variable, so it reads
 * "degraded" at every deploy check -- but taking the app down over it would take away the
 * pages that show the address.
 *
 * **It reads degraded on latency, not only on absence (#813).** Throughout #803 it answered
 * "ok" while its own `SELECT 1` waited ten seconds for a pooled connection and every shop's
 * pages were blank. So it times that query and reads degraded past `HEALTH_DATABASE_WAIT_MS`
 * (1 s), and reads how far behind each queue is -- depth, and how long the job that has
 * waited longest to start has waited -- against the limits in `health.ts`. Still a 200:
 * Railway fails a deploy on anything but a 200, and all of it is load the *previous*
 * release is carrying (the reasoning is at the top of `health.ts`).
 *
 * Unauthenticated on purpose: it is called by the platform before any session exists, and
 * it returns no shop data — only whether its dependencies answered and how long they took.
 * The queue entry carries counts and ages per queue, never which shop's jobs they are.
 */

import prisma from "../db.server";
import { supportEmailConfigured } from "../services/support.server";
import { TICK_SILENCE_SECONDS } from "../lib/observability/alerts";
import {
  databaseSlow,
  healthLimits,
  httpStatusFor,
  queueProblems,
  readingOf,
  statusOf,
  type HealthLimits,
  type QueueReading,
} from "../lib/observability/health";
import { secondsSinceBeat } from "../services/scheduler-heartbeat.server";
import { probeRedis } from "../worker/queue-stats.server";
import type { QueueName } from "../worker/queues";

interface Check {
  ok: boolean;
  detail?: string;
  /** How long the database took to answer `SELECT 1`, connection wait included (#803). */
  waitMs?: number;
  /** And the wait past which that reads as degraded, so the body explains itself (#813). */
  limitMs?: number;
}

/**
 * `SELECT 1`, timed around the query itself (#813).
 *
 * The time is the pool wait: the query is a millisecond, and the rest is this request
 * queueing for a connection behind every page doing the same. It is this process's wait,
 * measured where it is felt; the DB layer's own per-process pool-wait metric (#810) covers
 * every query rather than this one.
 */
async function checkDatabase(limits: HealthLimits): Promise<Check> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const waitMs = Date.now() - started;
    if (databaseSlow(waitMs, limits)) {
      return {
        ok: true,
        waitMs,
        limitMs: limits.databaseWaitMs,
        detail:
          `The database took ${(waitMs / 1000).toFixed(1)} s to answer a trivial query: pages are waiting for ` +
          "database connections, so the app is slow or blank for every shop. Something is holding the pool.",
      };
    }
    return { ok: true, waitMs, limitMs: limits.databaseWaitMs };
  } catch (error) {
    return {
      ok: false,
      waitMs: Date.now() - started,
      limitMs: limits.databaseWaitMs,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

interface QueuesCheck {
  ok: boolean;
  detail?: string;
  /** Per queue: jobs waiting, running or delayed, and the oldest waiting job's age. */
  byQueue?: Partial<Record<QueueName, QueueReading>>;
}

/**
 * Redis, and how far behind each queue is (#813), over one short-lived connection.
 *
 * Degraded past a limit and never more: a backlog is load, and the queue being behind is
 * a reason to look rather than a reason to refuse a deploy.
 */
async function checkRedisAndQueues(limits: HealthLimits): Promise<{ redis: Check; queues: QueuesCheck }> {
  const probe = await probeRedis();
  const redis: Check = probe.ok ? { ok: true } : { ok: false, detail: probe.detail };

  if (!probe.snapshots) {
    // Not read is not "fine", and not a second failure either: whatever stopped it is
    // already the `redis` entry's to report.
    return { redis, queues: { ok: false, detail: probe.queuesDetail } };
  }

  // After the read, so a job enqueued while Redis was answering cannot be in the future.
  const now = Date.now();
  const byQueue = Object.fromEntries(
    probe.snapshots.map((snapshot) => [snapshot.queue, readingOf(snapshot, now)]),
  ) as Partial<Record<QueueName, QueueReading>>;
  const problems = queueProblems(byQueue, limits);

  return {
    redis,
    queues: problems.length
      ? { ok: false, detail: `Behind: ${problems.join("; ")}.`, byQueue }
      : { ok: true, byQueue },
  };
}

/**
 * Whether the scheduler has beaten recently enough.
 *
 * `null` seconds means it has never beaten — a worker that has not started rather than one
 * that has stopped. Reported as `"never"` rather than as stale, because on a fresh
 * deployment those are very different things and only one of them is a problem.
 */
async function checkScheduler(): Promise<Check & { secondsSinceTick: number | null }> {
  try {
    const seconds = await secondsSinceBeat();
    if (seconds === null) {
      return { ok: false, detail: "never — the worker has not started", secondsSinceTick: null };
    }
    return {
      ok: seconds <= TICK_SILENCE_SECONDS,
      detail: seconds <= TICK_SILENCE_SECONDS ? undefined : `quiet for ${seconds}s`,
      secondsSinceTick: seconds,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      secondsSinceTick: null,
    };
  }
}

/** Whether support requests and notification emails can be sent at all (#758). */
function checkMail(): Check {
  return supportEmailConfigured()
    ? { ok: true }
    : {
        ok: false,
        detail:
          "RESEND_API_KEY, NOTIFICATION_FROM_EMAIL and SUPPORT_EMAIL are not all set: Contact support cannot send, so merchants are shown the support address instead",
      };
}

export async function loader() {
  const limits = healthLimits();
  const [database, { redis, queues }, scheduler] = await Promise.all([
    checkDatabase(limits),
    checkRedisAndQueues(limits),
    checkScheduler(),
  ]);
  const mail = checkMail();

  // Only the database can fail the check. Without it nothing works; without Redis the
  // queue runs inline and campaigns still apply. Slow and behind are degraded, not down: a
  // 503 would fail a deploy's health check for load the new release did not cause.
  const degradedBy = [
    ...(databaseSlow(database.waitMs, limits) ? ["database"] : []),
    ...(redis.ok ? [] : ["redis"]),
    // A queue that could not be read because Redis is down is the `redis` entry's news,
    // not a second reason; one that was read and is behind is its own.
    ...(queues.ok || !redis.ok ? [] : ["queues"]),
    ...(scheduler.ok ? [] : ["scheduler"]),
    ...(mail.ok ? [] : ["mail"]),
  ];
  const status = statusOf({ databaseAnswered: database.ok, degradedBy });

  return new Response(
    JSON.stringify({
      status,
      // Which entries made it degraded, so a reader polling this does not have to work
      // out which `ok: false` -- or which slow `ok: true` -- is the reason.
      ...(status === "degraded" ? { degradedBy } : {}),
      database,
      redis,
      queues,
      scheduler,
      mail,
    }),
    { status: httpStatusFor(status), headers: { "content-type": "application/json" } },
  );
}
