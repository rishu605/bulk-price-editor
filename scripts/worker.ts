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

import Redis from "ioredis";

import { tick } from "../app/services/scheduler.server";
import { LeaderLock } from "../app/worker/leader-lock";
import { pruneWriteIntents } from "../app/services/drift.server";
import prisma from "../app/db.server";

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

  await Promise.allSettled([redis.quit(), prisma.$disconnect()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void loop();
