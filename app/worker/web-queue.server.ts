/**
 * The web process's way of handing work to the worker (#772).
 *
 * Enqueue-only: the web process never consumes, so a job it adds is always run by the
 * worker, which has no request deadline. Null where there is no Redis -- development
 * without it, or a deployment missing it -- and then there is no worker queue to hand
 * anything to, so the caller does the work itself, as it always did.
 *
 * One runtime per process, created on first use: a connection per request would be a
 * connection leak with extra steps.
 */

import { logger } from "../lib/logging/logger";
import { redisRuntime, type QueueRuntime } from "./queue-runtime.server";

let runtime: QueueRuntime | null | undefined;

export function webQueue(): QueueRuntime | null {
  if (runtime !== undefined) return runtime;

  // eslint-disable-next-line no-undef
  const url = process.env.REDIS_URL;
  if (!url) return (runtime = null);

  try {
    const parsed = new URL(url);
    runtime = redisRuntime(
      async () => {
        throw new Error("The web process enqueues jobs and never runs them.");
      },
      {
        connection: {
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          ...(parsed.password ? { password: parsed.password } : {}),
        },
        consume: false,
      },
    );
  } catch (error) {
    logger.error("REDIS_URL is not a valid URL; nothing can be handed to the worker", {
      error: error instanceof Error ? error.message : String(error),
    });
    runtime = null;
  }
  return runtime;
}
