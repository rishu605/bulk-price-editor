/**
 * How long this process waits for a database connection, measured all the time (#810).
 *
 * #803 found the starvation by reading `/healthz` by hand: its `SELECT 1` waited 9–12 s
 * while a 102k-variant run held the pool, and nothing else said so. #810's criterion -- a
 * page's database wait under 1 s p95 during that run -- needs the same number continuously,
 * per process, which is this: a trivial query timed every `POOL_WAIT_SAMPLE_MS`, emitted as
 * the `db.pool_wait_ms` histogram labelled `process: web | worker`.
 *
 * A trivial query because it costs the database nothing, so its time is the wait for a
 * connection plus one round trip -- the part a page cannot do anything about. Prisma has no
 * hook into the pool's acquire; its `metrics` preview would, but it is being withdrawn, and
 * this is what `/healthz` already relies on.
 *
 * Also kept in memory (`recentPoolWait`) for anything in the same process that wants the
 * number without a metrics backend: `/healthz` can report the last minutes' p95 rather than
 * the one query it made itself, and can feed its own measurement in through
 * `measurePoolWait`.
 */

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logging/logger";
import { metric } from "../telemetry/metrics";
import type { ProcessRole } from "./pool";

/** How often each process samples its own pool. */
export const POOL_WAIT_SAMPLE_MS = 10_000;

/** Samples kept in memory: ten minutes at the default rate, the window #803 watched. */
export const POOL_WAIT_WINDOW = 60;

type Client = Pick<PrismaClient, "$queryRaw">;

interface Sample {
  ms: number;
  at: number;
}

const window: Sample[] = [];
let role: ProcessRole = "web";

function remember(ms: number): void {
  window.push({ ms, at: Date.now() });
  if (window.length > POOL_WAIT_WINDOW) window.splice(0, window.length - POOL_WAIT_WINDOW);
}

/**
 * Times one trivial query through `client`, records it, and returns the milliseconds.
 *
 * Throws what the query throws -- a P2024 is itself the answer "waited the whole pool
 * timeout", and the caller decides what to say about it. The wait is recorded either way,
 * because a sample that failed after nine seconds is the most important one in the window.
 */
export async function measurePoolWait(client: Client): Promise<number> {
  const started = Date.now();
  let ms = 0;
  try {
    await client.$queryRaw`SELECT 1`;
  } finally {
    ms = Date.now() - started;
    remember(ms);
    metric("db.pool_wait_ms", ms, { process: role });
  }
  return ms;
}

export interface PoolWaitSummary {
  process: ProcessRole;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  /** When the last sample was taken, ISO, or null before the first. */
  lastAt: string | null;
}

/** The in-memory window, summarised: what this process's pool has felt like lately. */
export function recentPoolWait(): PoolWaitSummary {
  const sorted = window.map((sample) => sample.ms).sort((a, b) => a - b);
  const at = (q: number) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);
  const last = window[window.length - 1];
  return {
    process: role,
    samples: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
    lastMs: last?.ms ?? null,
    lastAt: last ? new Date(last.at).toISOString() : null,
  };
}

/** Clears the window, for tests. */
export function resetPoolWaitForTests(): void {
  window.length = 0;
  role = "web";
}

declare global {
  // eslint-disable-next-line no-var
  var anchorPoolWaitSampler: ReturnType<typeof setInterval> | undefined;
}

/**
 * Samples this process's pool every `everyMs`, until the process exits.
 *
 * One sampler per process, whatever calls this: `vite dev` re-evaluates the entry module on
 * every edit, and a sampler per reload would multiply the queries it is measuring. Skips a
 * tick while the last sample is still waiting, so a starved pool is measured, not queued
 * behind its own measurements. Unref'd, so it never holds a process open on its own.
 */
export function startPoolWaitSampler(client: Client, as: ProcessRole, everyMs: number = POOL_WAIT_SAMPLE_MS): void {
  role = as;
  if (global.anchorPoolWaitSampler) return;

  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    measurePoolWait(client)
      .catch((error: unknown) => {
        // The wait is already recorded. Said once per failed sample, by code, so a pool
        // timeout here reads as what it is rather than as a crash.
        logger.warn("pool-wait sample failed", { process: as, code: (error as { code?: string })?.code });
      })
      .finally(() => {
        inFlight = false;
      });
  }, everyMs);
  timer.unref?.();
  global.anchorPoolWaitSampler = timer;
}
