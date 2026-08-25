/**
 * Spawning and killing the process that runs a campaign.
 *
 * SIGKILL, not SIGTERM: the graceful path is already covered by the worker's own
 * shutdown handling, and a chaos suite that only ever shuts things down politely
 * proves nothing about a crash, an OOM kill or a pod eviction. SIGKILL gives the
 * process no chance to tidy up, which is the state the ledger has to survive.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import type { RunOutcome } from "../../app/services/campaigns/types";
import type { FakeShopifyServer } from "./shopify-server";

export interface ChildRun {
  pid?: number;
  /** Resolves with the outcome, or null if the process was killed before finishing. */
  finished: Promise<RunOutcome | null>;
  kill(): void;
  killed(): boolean;
}

export interface ChildRunOptions {
  endpoint: string;
  shopId: string;
  campaignId: string;
  resume?: boolean;
  /** Overrides the child's database connection, so it can be cut independently. */
  databaseUrl?: string;
}

export function startApply(options: ChildRunOptions): ChildRun {
  const entry = join(process.cwd(), "chaos", "harness", "apply-child.ts");

  // The local binary directly, not through `npx`: npx re-resolves the package on
  // every spawn, which added tens of seconds to a suite that spawns repeatedly.
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");

  const child: ChildProcess = spawn(tsx, [entry], {
    env: {
      ...process.env,
      CHAOS_ENDPOINT: options.endpoint,
      CHAOS_SHOP_ID: options.shopId,
      CHAOS_CAMPAIGN_ID: options.campaignId,
      CHAOS_RESUME: options.resume ? "1" : "0",
      ...(options.databaseUrl ? { DATABASE_URL: options.databaseUrl } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the kill below reaches `tsx` and not just the
    // `npx` wrapper that spawned it.
    detached: true,
  });

  let wasKilled = false;
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  const finished = new Promise<RunOutcome | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal || wasKilled) return resolve(null);

      const line = stdout.split("\n").find((l) => l.startsWith("CHAOS_OUTCOME "));
      if (!line) {
        return reject(
          new Error(`apply-child exited ${code} with no outcome.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
      }
      resolve(JSON.parse(line.slice("CHAOS_OUTCOME ".length)) as RunOutcome);
    });
  });

  return {
    pid: child.pid,
    finished,
    killed: () => wasKilled,
    kill: () => {
      wasKilled = true;
      // The whole group, so a kill reaches any process tsx has forked rather than
      // leaving the one holding the database connections happily writing.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}

/** Waits until the store has accepted `count` writes, or throws having said so. */
export async function waitForWrites(
  server: FakeShopifyServer,
  count: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (server.fake.writeLog.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} writes; the store saw ${server.fake.writeLog.length}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Waits until the store has accepted `count` writes, then kills the child.
 *
 * Timing the kill off observed writes rather than a sleep is what makes "mid-chunk"
 * mean mid-chunk. A fixed delay lands somewhere different on every machine, and a
 * scenario that sometimes kills before the first write and sometimes after the last
 * is a scenario that tests something different each run.
 */
export async function killAfterWrites(
  server: FakeShopifyServer,
  child: ChildRun,
  count: number,
  timeoutMs = 60_000,
): Promise<void> {
  try {
    await waitForWrites(server, count, timeoutMs);
  } catch (error) {
    child.kill();
    throw error;
  }

  child.kill();
  await child.finished;
}
