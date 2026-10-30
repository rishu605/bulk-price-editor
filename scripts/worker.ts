#!/usr/bin/env node
/**
 * The worker process: the only thing that writes prices on a schedule.
 *
 * Deliberately separate from the web process. Web serves the admin UI and computes
 * previews; it never writes. Giving the worker its own process means it can be
 * restarted, scaled and rate-limited on its own, and a slow campaign cannot tie up
 * a request thread.
 *
 *   npm run worker
 */

// First, before anything that reaches `db.server`: the client is built when that module is
// first evaluated, and imports evaluate in order, so this is the only place a declaration
// can land in time to give the worker its own pool rather than the web's (#810).
import "../app/worker/as-worker";

import Redis from "ioredis";

import { initSentry } from "../app/lib/observability/sentry.server";
import { initOtel, shutdownOtel } from "../app/lib/observability/otel.server";
import { tick } from "../app/services/scheduler.server";
import { reportDepths, runtimeFor } from "../app/worker/queue-runtime.server";
import { handleJob } from "../app/worker/handlers.server";
import { LeaderLock } from "../app/worker/leader-lock";
import { pruneWriteIntents } from "../app/services/drift.server";
import { ringStrandedWebhooks } from "../app/services/webhook-queue.server";
import prisma, { databasePool } from "../app/db.server";
import { reportPoolBudget } from "../app/lib/db/budget.server";
import { startPoolWaitSampler } from "../app/lib/db/pool-wait.server";
import { QUEUE_POLICIES } from "../app/worker/queues";

const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_MS ?? 30_000);
const LOCK_TTL_MS = Math.max(TICK_INTERVAL_MS * 2, 30_000);

// Fail fast and loudly on missing configuration. A worker that starts without a
// database and then fails silently per-tick is far harder to diagnose than one that
// refuses to start at all.
for (const key of ["DATABASE_URL"]) {
  if (!process.env[key]) {
    console.error(`[worker] Missing required environment variable ${key}`);
    process.exit(1);
  }
}

// Built for the web, the worker would run its writes under whatever statement timeout the
// web's pages were given -- a run cancelled part-way by a limit meant for a page (#810). An
// import reordered above `as-worker` is the way that happens, and it is caught here, at
// boot, where it is a failed deploy rather than a stream of Partial runs.
if (databasePool.role !== "worker") {
  console.error(
    `[worker] The database client was built for the ${databasePool.role} process, not the worker: ` +
      "`app/worker/as-worker` must be the first import in scripts/worker.ts.",
  );
  process.exit(1);
}

initSentry({ process: "worker" });
void initOtel({ process: "worker" });

// The connection budget against `max_connections`, logged once, and this pool's wait sampled
// from then on (#810): the worker's pool is the one a run lives in. It is also every queue's:
// told how many jobs can run at once -- the products-webhook drains (#811) included, and the
// scheduler's tick, which runs due campaigns itself -- so it can say when the pool is smaller.
const queueSlots = Object.values(QUEUE_POLICIES);
void reportPoolBudget(prisma, databasePool, {
  concurrentJobs: {
    total: queueSlots.reduce((sum, policy) => sum + policy.concurrency, 0) + 1,
    detail: [...queueSlots.map((policy) => `${policy.name} ${policy.concurrency}`), "scheduler tick 1"].join(", "),
  },
});
startPoolWaitSampler(prisma, databasePool.role);

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  // Surface connection problems rather than hiding them: a lost Redis connection
  // means the leader lock is gone, which is exactly when two workers could collide.
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});

redis.on("error", (error) => {
  console.error("[worker] redis error:", error.message);
});

const lock = new LeaderLock(redis, "anchor:scheduler:leader", LOCK_TTL_MS);

// Queue consumers start with the process, not with leadership. Only one worker may
// *schedule*, because two deciding a campaign is due would start it twice — but every
// worker should be draining queues, which is the entire point of running more than one.
const queues = runtimeFor(handleJob);

let running = true;
let isLeader = false;
let ticks = 0;

async function runOnce(): Promise<void> {
  // Renew if we already lead, otherwise try to take over. A failed renewal means we
  // lost the lock -- fall back to acquiring rather than assuming we still lead.
  isLeader = isLeader ? await lock.renew() : await lock.acquire();
  if (!isLeader) return;

  const started = Date.now();
  const result = await tick();
  ticks++;

  // Reported from the leader only, so N replicas do not publish N copies of the same
  // number. A rising floor here is the earliest signal that the worker is losing
  // ground, and the one that predicts a missed scheduled revert before it is missed.
  await reportDepths(queues);

  // Products deliveries persisted and never drained: their job was not taken or was lost
  // (#811). A shop whose drain is merely busy absorbs the ring; the rest get one.
  // Its own failure, so it never costs the housekeeping below its turn.
  try {
    const rung = await ringStrandedWebhooks(queues);
    if (rung > 0) console.log(`[worker] rang ${rung} shop(s) with products webhooks left waiting`);
  } catch (error) {
    console.error("[worker] could not ring stranded products webhooks:", error instanceof Error ? error.message : error);
  }

  if (
    result.applied > 0 ||
    result.reverted > 0 ||
    result.enrolled > 0 ||
    result.failures.length > 0
  ) {
    console.log(
      `[worker] tick ${ticks}: examined ${result.examined}, applied ${result.applied}, ` +
        `reverted ${result.reverted}, enrolled ${result.enrolled}, ` +
        `failed ${result.failures.length} (${Date.now() - started}ms)`,
    );
    for (const failure of result.failures) {
      console.error(`[worker]   campaign ${failure.campaignId}: ${failure.error}`);
    }
  }

  // Cheap housekeeping, only while we hold the lock so it happens once per cluster.
  if (ticks % 20 === 0) {
    const pruned = await pruneWriteIntents();
    if (pruned > 0) console.log(`[worker] pruned ${pruned} expired write intents`);
  }
}

async function loop(): Promise<void> {
  console.log(
    `[worker] started, tick every ${TICK_INTERVAL_MS}ms, lock TTL ${LOCK_TTL_MS}ms`,
  );

  while (running) {
    try {
      await runOnce();
    } catch (error) {
      // Never let one bad tick kill the loop; the next one may well succeed.
      console.error("[worker] tick failed:", error instanceof Error ? error.message : error);
    }
    await sleep(TICK_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Graceful shutdown.
 *
 * Releasing the lock explicitly means a deploy hands leadership over in seconds
 * rather than leaving the cluster idle for a full TTL.
 */
async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  console.log(`[worker] ${signal} received, shutting down`);

  try {
    if (isLeader) await lock.release();
  } catch {
    // The lock expires on its own; a failure here must not block exit.
  }

  // Flushed before exit, so the last interval's metrics are not lost — which is the
  // interval covering whatever made somebody restart the worker.
  await Promise.allSettled([shutdownOtel(), queues.close(), redis.quit(), prisma.$disconnect()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void loop();
