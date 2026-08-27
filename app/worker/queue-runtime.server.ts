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

import { logger } from "../lib/logging/logger";
import { metric } from "../lib/telemetry/metrics";
import { span } from "../lib/observability/otel.server";
import {
  jobOptionsFor,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  type JobRef,
  type QueueName,
} from "./queues";

export interface QueueRuntime {
  enqueue(name: QueueName, ref: JobRef): Promise<void>;
  depths(): Promise<Record<QueueName, number>>;
  close(): Promise<void>;
}

export type Handler = (name: QueueName, ref: JobRef) => Promise<void>;

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
      await traced(name, ref, () => handler(name, ref));
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

export interface RedisRuntimeOptions {
  connection: { host: string; port: number; password?: string };
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
          await traced(name, job.data, () => handler(name, job.data));
        },
        { connection, concurrency: policy.concurrency },
      );

      // Logged rather than swallowed. A job class that is failing every attempt is the
      // thing an operator most needs to know, and BullMQ's default is silence.
      worker.on("failed", (job, error) => {
        logger.error("job failed", {
          queue: name,
          jobId: job?.id ?? null,
          attempts: job?.attemptsMade ?? 0,
          error: error?.message ?? String(error),
        });
        metric("queue.failed", 1, { queue: name });
      });

      workers.push(worker);
    }
  }

  return {
    async enqueue(name, ref) {
      const queue = queues.get(name);
      if (!queue) throw new Error(`No such queue: ${name}`);

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
          await queue.add(name, ref, jobOptionsFor(QUEUE_POLICIES[name]));
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
    const parsed = new URL(url);
    return redisRuntime(handler, {
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        ...(parsed.password ? { password: parsed.password } : {}),
      },
      consume: env.QUEUE_CONSUME !== "false",
    });
  } catch (error) {
    logger.error("REDIS_URL is not a valid URL; running jobs inline", {
      error: error instanceof Error ? error.message : String(error),
    });
    return inlineRuntime(handler);
  }
}

/** Reports queue depth as a metric. Called from the tick. */
export async function reportDepths(runtime: QueueRuntime): Promise<void> {
  const depths = await runtime.depths();

  for (const [queue, depth] of Object.entries(depths)) {
    metric("queue.depth", depth, { queue });
  }
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
async function traced(name: QueueName, ref: JobRef, work: () => Promise<void>): Promise<void> {
  await span(
    `job ${name}`,
    {
      "queue.name": name,
      "shop.id": ref.shopId,
      ...(ref.campaignId ? { "campaign.id": ref.campaignId } : {}),
      ...(ref.runId ? { "run.id": ref.runId } : {}),
      ...(ref.revert === undefined ? {} : { "job.revert": ref.revert }),
    },
    work,
  );
}
