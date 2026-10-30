/**
 * What `/healthz` calls degraded, and the numbers it decides that by (#813).
 *
 * Throughout #803 the check answered "ok" while its own `SELECT 1` waited ten seconds for a
 * pooled connection and every shop's pages were blank. It measured the wrong thing: whether
 * the database *answered*, not how long anybody had to wait for it. So it now reads
 * degraded on latency as well as on absence -- the database wait, and how far behind each
 * queue is -- and these are the rules.
 *
 * **Degraded is a 200, and has to stay one.** Railway holds a deploy at "deploying" until
 * `/healthz` answers 200 within `healthcheckTimeout` (120 s in `railway.json`); anything else
 * fails the deploy, and it never polls again once the deploy is live. Every condition here
 * is load, and load the *previous* release is carrying: a new container has a pool of its
 * own and has served nothing. A 503 for it would refuse a fixed release because the broken
 * one is busy -- the outage holding the fix out. Only a database that does not answer at
 * all is a 503, because then the release cannot serve anything and must not be promoted.
 *
 * Pure: the route reads the clocks and the stores, this decides. Thresholds come from the
 * environment with defaults, so an operator can tighten them without a deploy of code and
 * the tests can ask about the boundary without waiting for it.
 */

import { QUEUE_NAMES, type QueueName } from "../../worker/queues";

export type HealthStatus = "ok" | "degraded" | "unhealthy";

/**
 * How long the trivial query may wait before the app reads as degraded.
 *
 * `SELECT 1` takes a millisecond; everything above that is time spent waiting for a pooled
 * connection, which every page of every shop is waiting for at the same moment. One second
 * is the gate's own `/healthz` SLO (#813) and half the 2 s page budget, and was 2 s until
 * then: the 25 Sep run went 0.33 s → 1.8 s → 4.5 s before anything said so.
 */
export const DATABASE_WAIT_DEGRADED_MS = 1_000;

/**
 * One queue's limits: past either, the app reads as degraded. Null is "never", for a
 * queue whose backlog is not worth the word.
 */
export interface QueueLimit {
  /** Jobs waiting, running or delayed. */
  depth: number | null;
  /** How long the job that has waited longest to *start* has waited. */
  waitMs: number | null;
}

/**
 * The defaults, per queue, because one number cannot serve all six.
 *
 * Depth is a throughput signal and means something different on every queue: fifty jobs on
 * `execution` is fifty merchants' campaigns, while `webhooks` holds one drain per shop
 * (#811) and its depth is how many shops have deliveries waiting. The age of the oldest
 * waiting job is the latency signal, and it is the one that says a shop is waiting behind
 * another.
 *
 *   `execution` -- a merchant's apply or revert, and the queue the epic is about. A minute
 *   behind another shop's run is the #807 failure, and the gate's 1-variant apply has 30 s
 *   end to end. Depth 50 is `EXECUTION_BACKLOG`, the alert's own number.
 *
 *   `webhooks` -- well under the five minutes `webhook-lag` pages at, because a stalled
 *   queue produces no processed deliveries and that alert goes quiet rather than firing.
 *   Depth 200 is two hundred shops with deliveries unread at once; a revert's echo storm,
 *   the 25 Sep flood, is one shop's drain since #811 and waits in `webhook_events`.
 *
 *   `sync` -- concurrency one, and a full import of the perf store is about three minutes,
 *   so a shop waiting behind one or two of them is expected and ten minutes is not.
 *
 *   `audit` -- never. `NOT_ALERTS` calls it the least urgent thing in the system; it is
 *   reported here and degrades nothing.
 */
export const QUEUE_LIMITS: Record<QueueName, QueueLimit> = {
  sync: { depth: 50, waitMs: 10 * 60_000 },
  webhooks: { depth: 200, waitMs: 2 * 60_000 },
  planning: { depth: 200, waitMs: 2 * 60_000 },
  execution: { depth: 50, waitMs: 60_000 },
  verification: { depth: 200, waitMs: 5 * 60_000 },
  audit: { depth: null, waitMs: null },
};

export interface HealthLimits {
  databaseWaitMs: number;
  queues: Record<QueueName, QueueLimit>;
}

/**
 * The limits this process runs with.
 *
 *   HEALTH_DATABASE_WAIT_MS   one number, milliseconds
 *   HEALTH_QUEUE_DEPTH        `queue=n` pairs, comma-separated: `webhooks=500,execution=20`
 *   HEALTH_QUEUE_WAIT_MS      the same shape, milliseconds
 *
 * Anything unreadable keeps the default rather than throwing: a typo in a threshold must
 * not take down the endpoint that reports whether the app is up.
 */
export function healthLimits(env: Record<string, string | undefined> = process.env): HealthLimits {
  const depth = queueOverrides(env.HEALTH_QUEUE_DEPTH);
  const wait = queueOverrides(env.HEALTH_QUEUE_WAIT_MS);

  return {
    databaseWaitMs: positive(env.HEALTH_DATABASE_WAIT_MS) ?? DATABASE_WAIT_DEGRADED_MS,
    queues: Object.fromEntries(
      QUEUE_NAMES.map((name) => [
        name,
        {
          depth: depth[name] ?? QUEUE_LIMITS[name].depth,
          waitMs: wait[name] ?? QUEUE_LIMITS[name].waitMs,
        },
      ]),
    ) as Record<QueueName, QueueLimit>,
  };
}

/** `queue=n` pairs. Unknown queues and non-numbers are dropped, for the reason above. */
export function queueOverrides(text: string | undefined): Partial<Record<QueueName, number>> {
  const out: Partial<Record<QueueName, number>> = {};
  for (const pair of (text ?? "").split(",")) {
    const [name, value] = pair.split("=").map((part) => part.trim());
    const n = positive(value);
    if (n !== null && (QUEUE_NAMES as readonly string[]).includes(name)) out[name as QueueName] = n;
  }
  return out;
}

function positive(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One queue, as read from Redis.
 *
 * The *time* the oldest job was enqueued rather than its age, so the age is taken against
 * a clock read after Redis answered -- the same mistake `secondsSinceBeat` made with the
 * database (#813), where a `now` taken before a slow read produced negative ages.
 */
export interface QueueSnapshot {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  /** When the job that has waited longest to start was enqueued (epoch ms); null if none waits. */
  oldestWaitingAt: number | null;
  /**
   * The same per shop, for `execution` only: that queue's jobs are shops' runs, and "one
   * shop waiting behind another" is the incident #807 is about. Never sent out of
   * `/healthz`, which is unauthenticated and returns no shop data.
   */
  oldestWaitingAtByShop?: Record<string, number>;
}

/** What `/healthz` says about one queue. */
export interface QueueReading {
  depth: number;
  oldestWaitMs: number | null;
}

/**
 * Milliseconds since `at`, never negative.
 *
 * Enqueue times come from whichever process enqueued, and its clock is not this one; a
 * job stamped a few milliseconds "in the future" has waited no time at all, not minus some.
 */
export function waitedMs(at: number | null | undefined, now: number): number | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/** Depth the way `queue.depth` has always counted it: waiting, running and delayed. */
export function readingOf(snapshot: QueueSnapshot, now: number): QueueReading {
  return {
    depth: snapshot.waiting + snapshot.active + snapshot.delayed,
    oldestWaitMs: waitedMs(snapshot.oldestWaitingAt, now),
  };
}

/**
 * Every queue past one of its limits, as sentences naming the queue, the number and the
 * limit -- what somebody reading the body needs, without a second lookup.
 */
export function queueProblems(
  readings: Partial<Record<QueueName, QueueReading>>,
  limits: HealthLimits,
): string[] {
  const problems: string[] = [];
  for (const name of QUEUE_NAMES) {
    const reading = readings[name];
    if (!reading) continue;
    const limit = limits.queues[name];

    if (limit.waitMs !== null && reading.oldestWaitMs !== null && reading.oldestWaitMs > limit.waitMs) {
      problems.push(
        `${name}: a job has waited ${seconds(reading.oldestWaitMs)} to start (limit ${seconds(limit.waitMs)})`,
      );
    }
    if (limit.depth !== null && reading.depth > limit.depth) {
      problems.push(`${name}: ${reading.depth} jobs deep (limit ${limit.depth})`);
    }
  }
  return problems;
}

/** Strictly over, so a wait landing exactly on the limit is not degraded. */
export function databaseSlow(waitMs: number | undefined, limits: HealthLimits): boolean {
  return waitMs !== undefined && waitMs > limits.databaseWaitMs;
}

/**
 * The status word. Unhealthy only when the database did not answer; anything else that is
 * wrong is degraded. See the note at the top for why that line is where it is.
 */
export function statusOf(parts: { databaseAnswered: boolean; degradedBy: readonly string[] }): HealthStatus {
  if (!parts.databaseAnswered) return "unhealthy";
  return parts.degradedBy.length > 0 ? "degraded" : "ok";
}

/** 200 for ok and degraded alike: Railway fails a deploy on anything else. */
export function httpStatusFor(status: HealthStatus): 200 | 503 {
  return status === "unhealthy" ? 503 : 200;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
