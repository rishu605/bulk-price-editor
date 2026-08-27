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
 * Unauthenticated on purpose: it is called by the platform before any session exists, and
 * it returns no shop data — only whether its dependencies answered.
 */

import prisma from "../db.server";
import { TICK_SILENCE_SECONDS } from "../lib/observability/alerts";
import { secondsSinceBeat } from "../services/scheduler-heartbeat.server";

interface Check {
  ok: boolean;
  detail?: string;
}

async function checkDatabase(): Promise<Check> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkRedis(): Promise<Check> {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, detail: "REDIS_URL is not set" };

  // Imported here rather than at module scope so a web process with no Redis does not
  // pay for the client on every request that is not this one.
  const { default: Redis } = await import("ioredis");
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    await client.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    client.disconnect();
  }
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

export async function loader() {
  const [database, redis, scheduler] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkScheduler(),
  ]);

  // Only the database can fail the check. Without it nothing works; without Redis the
  // queue runs inline and campaigns still apply.
  const status = database.ok ? 200 : 503;

  return new Response(
    JSON.stringify({
      status: database.ok ? (redis.ok && scheduler.ok ? "ok" : "degraded") : "unhealthy",
      database,
      redis,
      scheduler,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
