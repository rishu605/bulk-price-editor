/**
 * Reading Redis from outside the worker: is it there, and how far behind is each queue (#813).
 *
 * Two readers need this and neither owns a queue runtime. `/healthz` runs in the web
 * process, which only enqueues; the alerting job runs inside the tick, which is handed no
 * runtime. Both read through one short-lived connection they close again, for two reasons:
 *
 *   It cannot hang. BullMQ's own connections retry forever (`maxRetriesPerRequest: null`),
 *   which is right for a worker and wrong for a health check -- one that waits on a dead
 *   Redis never answers, and an answer is the whole job. This one gives up in two seconds.
 *
 *   It leaves nothing behind. A connection kept per process for a check that runs every
 *   few seconds is a second pool of things to leak, in the process whose pool the epic is
 *   about.
 *
 * Never throws: every failure is a sentence in the result, because both callers report
 * rather than fail.
 */

import { Queue } from "bullmq";

import type { QueueSnapshot } from "../lib/observability/health";
import { connectionFor, snapshotQueues } from "./queue-runtime.server";
import { QUEUE_NAMES } from "./queues";

/** Connect, and each command, before the reader gives up. */
const REDIS_TIMEOUT_MS = 2_000;

export interface RedisProbe {
  /** Redis answered a PING. */
  ok: boolean;
  detail?: string;
  /** Every queue, or null when they could not be read -- with `queuesDetail` saying why. */
  snapshots: QueueSnapshot[] | null;
  queuesDetail?: string;
}

/** PING, then every queue's counts and oldest waiting job, on one connection. */
export async function probeRedis(url: string | undefined = process.env.REDIS_URL): Promise<RedisProbe> {
  if (!url) return { ok: false, detail: "REDIS_URL is not set", snapshots: null, queuesDetail: "no queue: jobs run inline" };

  // Imported here rather than at module scope so a web process with no Redis does not
  // pay for the client on every request that is not this one.
  const { default: Redis } = await import("ioredis");

  let client: InstanceType<typeof Redis>;
  try {
    client = new Redis({
      ...connectionFor(url),
      maxRetriesPerRequest: 1,
      connectTimeout: REDIS_TIMEOUT_MS,
      commandTimeout: REDIS_TIMEOUT_MS,
      lazyConnect: true,
    });
  } catch (error) {
    return { ok: false, detail: messageOf(error), snapshots: null, queuesDetail: "not read: REDIS_URL is not a valid URL" };
  }
  // The failure is reported in the result. Without a listener ioredis prints its own
  // "unhandled error event" for the same failure, once per retry.
  client.on("error", () => {});

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect();
    return { ok: false, detail: messageOf(error), snapshots: null, queuesDetail: "not read: Redis did not answer" };
  }

  // Over the connection that just answered. BullMQ leaves a connection it was handed open
  // when the queue closes, so it is closed once, below, after every queue is done with it.
  const queues = new Map(QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: client })] as const));
  for (const queue of queues.values()) queue.on("error", () => {});

  try {
    return { ok: true, snapshots: await snapshotQueues((name) => queues.get(name)!) };
  } catch (error) {
    return { ok: true, snapshots: null, queuesDetail: `not read: ${messageOf(error)}` };
  } finally {
    await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
    client.disconnect();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
