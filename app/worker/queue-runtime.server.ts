/**
 * Connecting the job classes to Redis, and surviving its absence.
 *
 * Two things this has to be careful about.
 *
 * **Redis being unavailable must not stop prices being written.** The scheduler tick
 * already works without a queue, and it is what runs in development, in the chaos suite
 * and in any deployment where Redis has fallen over. So enqueueing degrades to running
 * inline rather than throwing: the work still happens, just without the isolation
 * between job classes that the queue provides.
 *
 * That is a deliberate trade. Losing queue isolation is a performance problem; refusing
 * to revert a sale because a cache is down is a merchant-facing one.
 *
 * **Queue depth is a metric, not a log line.** A backlog is the earliest signal that the
 * worker is losing ground, and it is the one number that predicts a missed scheduled
 * revert before it is missed.
 */

import { Queue, Worker, type Job } from "bullmq";

import { readingOf, type QueueSnapshot } from "../lib/observability/health";
import { logger } from "../lib/logging/logger";
import { metric } from "../lib/telemetry/metrics";
import { span } from "../lib/observability/otel.server";
import { withLogContext } from "../lib/logging/context.server";
import {
  jobOptionsFor,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  type JobRef,
  type JobResult,
  type QueueName,
} from "./queues";

export interface QueueRuntime {
  enqueue(name: QueueName, ref: JobRef): Promise<void>;
  depths(): Promise<Record<QueueName, number>>;
  /**
   * Each queue's counts and the enqueue time of its longest-waiting job (#813). Optional:
   * only a runtime with a real queue has a wait to measure, and the stand-ins the chaos
   * suite hands the web process have no reason to grow one.
   */
  snapshots?(): Promise<QueueSnapshot[]>;
  close(): Promise<void>;
}

export type Handler = (name: QueueName, ref: JobRef) => Promise<JobResult>;

/**
 * A runtime that runs everything inline.
 *
 * Used when there is no Redis, and by the chaos suite, which needs the work to have
 * happened by the time the call returns so it can assert on the result rather than on
 * a promise that something will happen eventually.
 */
export function inlineRuntime(handler: Handler): QueueRuntime {
  return {
    async enqueue(name, ref) {
      // A turn that asks for another gets it here and now: inline, there is nobody else's
      // turn to go behind, and the caller is promised the work is done when this returns.
      while ((await traced(name, ref, () => handler(name, ref))) === "again");
    },
    async depths() {
      return Object.fromEntries(QUEUE_NAMES.map((name) => [name, 0])) as Record<
        QueueName,
        number
      >;
    },
    async close() {},
  };
}

export interface RedisConnection {
  host: string;
  port: number;
  password?: string;
  /** The database index in the URL's path, which this used to drop (#813). */
  db?: number;
}

export interface RedisRuntimeOptions {
  connection: RedisConnection;
  /** Set false in a process that only enqueues, so the web process never executes. */
  consume?: boolean;
}

export function redisRuntime(handler: Handler, options: RedisRuntimeOptions): QueueRuntime {
  const connection = { ...options.connection, maxRetriesPerRequest: null };

  const queues = new Map<QueueName, Queue>();
  const workers: Worker[] = [];

  for (const name of QUEUE_NAMES) {
    queues.set(name, new Queue(name, { connection }));
  }

  if (options.consume !== false) {
    for (const name of QUEUE_NAMES) {
      const policy = QUEUE_POLICIES[name];

      const worker = new Worker(
        name,
        async (job: Job<JobRef>) => {
          reportWait(name, job);
          const result = await traced(name, job.data, () => handler(name, job.data), job.id);
          // Another turn, asked for while this one still holds its key (#811): stored as its
          // successor and created behind everything already waiting when this one finishes.
          if (result === "again") await add(name, job.data, { again: true });
        },
        { connection, concurrency: policy.concurrency },
      );

      // Logged rather than swallowed. A job class that is failing every attempt is the
      // thing an operator most needs to know, and BullMQ's default is silence.
      worker.on("failed", (job, error) => {
        logger.error("job failed", {
          queue: name,
          // Explicit, because a `failed` listener fires outside the job's own async
          // context — the ambient binding in `traced` is long gone by then.
          jobId: job?.id ?? undefined,
          attempts: job?.attemptsMade ?? 0,
          error: error?.message ?? String(error),
        });
        metric("queue.failed", 1, { queue: name });
      });

      workers.push(worker);
    }
  }

  async function add(name: QueueName, ref: JobRef, { again = false }: { again?: boolean } = {}): Promise<void> {
    const queue = queues.get(name);
    if (!queue) throw new Error(`No such queue: ${name}`);
    await queue.add(name, ref, jobOptionsFor(QUEUE_POLICIES[name], ref, { again }));
  }

  return {
    async enqueue(name, ref) {
      if (!queues.has(name)) throw new Error(`No such queue: ${name}`);

      // Spanned, not only counted. The execution side has had a span since it was
      // written, so a trace showed a job appearing from nowhere and taking however long
      // it took — with no record of when it was asked for. The interesting number in a
      // backlog is the gap between those two, and a counter cannot express a gap.
      //
      // Same attributes as the execution span so the two line up in a trace view.
      await span(
        `enqueue ${name}`,
        {
          "queue.name": name,
          "shop.id": ref.shopId,
          ...(ref.campaignId ? { "campaign.id": ref.campaignId } : {}),
          ...(ref.runId ? { "run.id": ref.runId } : {}),
          ...(ref.revert === undefined ? {} : { "job.revert": ref.revert }),
        },
        async () => {
          await add(name, ref);
        },
      );

      metric("queue.enqueued", 1, { queue: name });
    },

    async depths() {
      const entries = await Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const queue = queues.get(name)!;
          const counts = await queue.getJobCounts("waiting", "active", "delayed");
          return [name, (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0)] as const;
        }),
      );

      return Object.fromEntries(entries) as Record<QueueName, number>;
    },

    async snapshots() {
      return snapshotQueues((name) => queues.get(name)!);
    },

    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all([...queues.values()].map((queue) => queue.close()));
    },
  };
}

/**
 * The runtime this process should use.
 *
 * Falls back to inline rather than failing, for the reason at the top of this file. It
 * says so at startup, once, because a deployment silently running without queue
 * isolation is exactly the thing somebody should notice before it matters.
 */
export function runtimeFor(handler: Handler, env = process.env): QueueRuntime {
  const url = env.REDIS_URL;
  if (!url) {
    logger.warn("no REDIS_URL; running jobs inline without queue isolation");
    return inlineRuntime(handler);
  }

  try {
    return redisRuntime(handler, {
      connection: connectionFor(url),
      consume: env.QUEUE_CONSUME !== "false",
    });
  } catch (error) {
    logger.error("REDIS_URL is not a valid URL; running jobs inline", {
      error: error instanceof Error ? error.message : String(error),
    });
    return inlineRuntime(handler);
  }
}

/**
 * Where a `REDIS_URL` points, as BullMQ's connection options.
 *
 * The database index is kept (#813). It used to be dropped, so `redis://host:6379/4` sent
 * every queue to database 0 while the leader lock and `/healthz`'s ping -- plain ioredis
 * clients, which read the index -- used database 4. Production's URL has no index and was
 * never affected; two checkouts sharing one Redis by index were, and a reader of queue
 * depth that honoured the index would have been reading a different database from the one
 * the jobs were in.
 */
export function connectionFor(url: string): RedisConnection {
  const parsed = new URL(url);
  const db = Number(parsed.pathname.replace(/^\//, ""));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(Number.isInteger(db) && db > 0 ? { db } : {}),
  };
}

/**
 * How many of `execution`'s longest-waiting jobs are read to find each shop's wait.
 *
 * The queue's backlog alert is at fifty, so a sample this size sees every shop in any
 * backlog short of an incident -- and past it, the shops at the back are not the news.
 */
const RUN_WAIT_SAMPLE = 50;

/**
 * When a job could first have started: when it was added, plus any delay it asked for.
 *
 * The delay is not waiting. A shop's first `webhooks` job is held five seconds so a
 * product's burst of deliveries lands before it is read (#811), and a retry waits out its
 * backoff; counting either as queue wait would report a calm queue as a slow one.
 */
export function runnableAt(job: { timestamp: number; delay?: number }): number {
  return job.timestamp + Math.max(0, job.delay ?? 0);
}

/**
 * Every queue's counts and its longest-waiting job, read through BullMQ (#813).
 *
 * `getWaiting` reads from the end the workers take from, so index 0 is the job that has
 * waited longest -- BullMQ's own ordering, rather than a reach into its key layout. Only
 * `waiting` jobs have a wait in this sense: an active one has started, and a delayed one is
 * waiting on purpose, for a backoff or #811's coalescing.
 *
 * Since #811 a `webhooks` job is a shop's drain rather than a delivery, one per shop, so its
 * wait is how long that shop's deliveries have gone unread -- the echo storm itself waits in
 * `webhook_events`, not here.
 */
export async function snapshotQueues(queueFor: (name: QueueName) => Queue): Promise<QueueSnapshot[]> {
  return Promise.all(
    QUEUE_NAMES.map(async (name): Promise<QueueSnapshot> => {
      const queue = queueFor(name);
      const [counts, front] = await Promise.all([
        queue.getJobCounts("waiting", "active", "delayed"),
        queue.getWaiting(0, name === "execution" ? RUN_WAIT_SAMPLE - 1 : 0),
      ]);

      const stamps = front.filter((job) => Number.isFinite(job?.timestamp));
      const snapshot: QueueSnapshot = {
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        oldestWaitingAt: stamps.length ? Math.min(...stamps.map(runnableAt)) : null,
      };

      if (name === "execution") {
        const byShop: Record<string, number> = {};
        for (const job of stamps) {
          const shopId = (job.data as Partial<JobRef> | undefined)?.shopId;
          if (typeof shopId !== "string") continue;
          byShop[shopId] = Math.min(byShop[shopId] ?? Infinity, runnableAt(job));
        }
        snapshot.oldestWaitingAtByShop = byShop;
      }
      return snapshot;
    }),
  );
}

/**
 * Reports queue depth, and how long each queue's oldest job has waited, as metrics. Called
 * from the tick.
 *
 * The age as well as the depth (#813), because depth cannot tell a queue that is busy
 * from one that is stuck: a dozen shops' drains queued at once is gone in seconds, while
 * one execution job waiting ten minutes is a merchant whose sale has not ended. Zero
 * when nothing waits rather than nothing at all, for the reason `inlineRuntime` gives: a
 * missing series reads as a broken exporter.
 */
export async function reportDepths(runtime: QueueRuntime): Promise<void> {
  const depths = await runtime.depths();

  for (const [queue, depth] of Object.entries(depths)) {
    metric("queue.depth", depth, { queue });
  }

  if (!runtime.snapshots) return;
  const snapshots = await runtime.snapshots();
  // After the read, never before it: a clock taken first counts Redis's own latency
  // against nobody and can put a job enqueued meanwhile in the future (#813).
  const now = Date.now();
  for (const snapshot of snapshots) {
    metric("queue.oldest_wait_ms", readingOf(snapshot, now).oldestWaitMs ?? 0, { queue: snapshot.queue });
  }
}

/**
 * How long this job waited for a worker, by queue and shop (#813).
 *
 * Per shop because that is the question the epic asks: whether one shop's work waits
 * behind another's. `execution` jobs are shops' runs, so its series is the per-shop run
 * wait; the others say the same of a shop's syncs and webhooks. First attempts only -- a
 * retry's "wait" is mostly the backoff it asked for, and would read as a slow queue.
 *
 * Both stamps are BullMQ's: `timestamp` when the job was added, `processedOn` when this
 * worker took it, less any delay the job asked for (`runnableAt`). Floored at zero, because
 * the two come from different processes' clocks. A drain's next turn (#811) is a new job, so
 * it is timed from when it was put behind the other shops, which is the wait that matters.
 */
function reportWait(name: QueueName, job: Job<JobRef>): void {
  if (job.attemptsMade > 0 || !job.processedOn || !job.timestamp) return;
  metric("queue.wait_ms", Math.max(0, job.processedOn - runnableAt(job)), {
    queue: name,
    ...(job.data?.shopId ? { shopId: job.data.shopId } : {}),
  });
}


/**
 * One span per job, whichever runtime ran it.
 *
 * Attributes are the queue and the ids, never the payload — a job carries ids by design
 * and a span that re-expanded them would put back exactly what the job class avoids.
 *
 * Wrapped around both runtimes rather than only the Redis one, so a trace from a
 * deployment running inline looks the same as one from a deployment with a queue. A
 * degraded mode that is invisible in tracing is a degraded mode nobody notices.
 */
async function traced<T>(
  name: QueueName,
  ref: JobRef,
  work: () => Promise<T>,
  jobId?: string,
): Promise<T> {
  // The same ids on the log lines as on the span. They were on the span from the day it
  // was written and on exactly one log line — `job failed` — so a failing job could be
  // seen but the handler output explaining it could not be filtered back to it.
  //
  // Outside the span rather than inside, so a handler that throws still logs with its
  // ids while `span()` is recording the exception.
  return withLogContext(
    {
      shopId: ref.shopId,
      campaignId: ref.campaignId,
      runId: ref.runId,
      jobId,
    },
    () =>
      span(
        `job ${name}`,
        {
          "queue.name": name,
          "shop.id": ref.shopId,
          ...(ref.campaignId ? { "campaign.id": ref.campaignId } : {}),
          ...(ref.runId ? { "run.id": ref.runId } : {}),
          ...(ref.revert === undefined ? {} : { "job.revert": ref.revert }),
        },
        work,
      ),
  );
}
