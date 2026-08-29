#!/usr/bin/env node
/**
 * What a merchant's admin feels like while campaigns are planning against the same tables.
 *
 *   npm run measure:concurrency -- --shop anchor-perf
 *
 * Every other number in `docs/perf/` is one statement at a time against an idle database.
 * That has been written down as a known gap since the first baseline:
 *
 *   "A merchant paging the catalogue while a 100K campaign runs is a different question,
 *    and the honest answer is that it has not been measured."
 *
 * This measures it, and the pool size it depends on. `db.server.ts` constructs
 * `new PrismaClient()` with no `connection_limit`, so Prisma sizes the pool from the CPU
 * count of whichever container it lands on -- once for the web process and again for the
 * worker, with nothing accounting for their sum against `max_connections`.
 *
 * Read-only. It plans campaigns rather than applying them, so nothing is written.
 *
 * ## Reading the output
 *
 * The interesting column is admin p95 *under load*, not planner throughput. A pricing app
 * that plans faster by making the catalogue page unusable has made the wrong trade: the
 * planner is a background job that can take another second, and the page is somebody
 * waiting.
 */

import { PrismaClient } from "@prisma/client";

import { chooseShop, shopArg } from "../app/lib/seed/target-shop";

/** Pool sizes to sweep, spanning the default that nobody chose. */
const POOL_SIZES = [1, 2, 5, 10, 21, 40];

/**
 * Concurrent campaigns planning at once.
 *
 * Four rather than one, but the app's own design permits fewer: the scheduler walks due
 * campaigns in a `for` loop with an `await` in it, inside a worker holding a cluster
 * lock, so a worker runs exactly one campaign at a time. Four is a deliberate overshoot
 * -- a worker, a merchant who pressed Apply, and headroom.
 */
const DEFAULT_CAMPAIGNS = 4;

/** Merchants paging the catalogue at once. What actually sizes the web process's pool. */
const DEFAULT_MERCHANTS = 1;

/** How long each pool size is held under load. */
const WINDOW_MS = 6_000;

export interface Latencies {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** p50/p95/max of a sample, or zeroes for an empty one. */
export function summarise(samples: readonly number[]): Latencies {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };

  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];

  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

/**
 * A connection string with an explicit pool size.
 *
 * Appended as a query parameter rather than passed to the client, because
 * `connection_limit` is a property of the URL in Prisma and there is no constructor
 * option for it. Existing parameters are preserved -- Railway's URL carries `sslmode`,
 * and dropping it would measure a connection nobody makes.
 */
export function urlWithPool(base: string, limit: number): string {
  const url = new URL(base);
  url.searchParams.set("connection_limit", String(limit));
  return url.toString();
}

/**
 * Whether an error is the pool refusing to hand out a connection.
 *
 * Worth separating from any other failure: a pool timeout is the finding, and counting it
 * as a generic error would report the run as broken rather than as saturated.
 */
export function isPoolTimeout(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "P2024" || /connection pool/i.test(message);
}

interface Result {
  pool: number;
  admin: Latencies;
  plannerRuns: number;
  poolTimeouts: number;
  otherErrors: number;
}

async function measurePool(
  shopId: string,
  pool: number,
  campaigns: number,
  merchants: number,
  loadCandidates: (shopId: string, ast: { groups: [] }) => Promise<unknown>,
  catalogue: (client: PrismaClient, shopId: string) => Promise<unknown>,
): Promise<Result> {
  const client = new PrismaClient({
    datasources: { db: { url: urlWithPool(process.env.DATABASE_URL ?? "", pool) } },
  });

  // The services take the module-level client, so the pool under test has to be the one
  // `db.server` handed out. Assigning the global before its first import is what makes
  // that work; here the module is already loaded, so the client is swapped on the object
  // the services are holding a reference to.
  const previous = globalThis.prismaGlobal;
  globalThis.prismaGlobal = client;

  const adminSamples: number[] = [];
  let plannerRuns = 0;
  let poolTimeouts = 0;
  let otherErrors = 0;
  let running = true;

  const count = (error: unknown) => {
    if (isPoolTimeout(error)) poolTimeouts++;
    else otherErrors++;
  };

  // Campaign planners, looping for the window. Each is the real `loadCandidates` over the
  // whole catalogue -- the heaviest read path the app has, and the one that holds a
  // connection for twenty-odd chunked statements in a row.
  const planners = Array.from({ length: campaigns }, async () => {
    while (running) {
      try {
        await loadCandidates(shopId, { groups: [] });
        plannerRuns++;
      } catch (error) {
        count(error);
      }
    }
  });

  // Merchants paging the catalogue throughout. Each page load is one sample, so the
  // percentiles below are what a person waits, not what the process averages.
  const browsing = Array.from({ length: merchants }, async () => {
    while (running) {
      const started = process.hrtime.bigint();
      try {
        await catalogue(client, shopId);
        adminSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
      } catch (error) {
        count(error);
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
  running = false;
  await Promise.all([...planners, ...browsing]);

  globalThis.prismaGlobal = previous;
  await client.$disconnect();

  return { pool, admin: summarise(adminSamples), plannerRuns, poolTimeouts, otherErrors };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const numeric = (flag: string, fallback: number) => {
    const at = args.indexOf(flag);
    return at === -1 ? fallback : Number(args[at + 1]);
  };
  const campaigns = numeric("--campaigns", DEFAULT_CAMPAIGNS);
  const merchants = numeric("--merchants", DEFAULT_MERCHANTS);

  const observed = new PrismaClient();
  globalThis.prismaGlobal = observed;

  const { default: prisma } = await import("../app/db.server");
  const { loadCandidates } = await import("../app/services/campaigns/candidates.server");
  const { ROWS_PER_VIEW } = await import("../app/lib/ui/table-budget");

  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(args)).domain },
  });
  const total = await prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } });

  /** One page of the catalogue, the way its loader asks for it. */
  const catalogue = async (client: PrismaClient, shopId: string) => {
    const variants = await client.variantIndex.findMany({
      where: { shopId, deletedAt: null },
      orderBy: [{ title: "asc" }, { variantGid: "asc" }],
      take: ROWS_PER_VIEW,
    });
    await client.baseline.findMany({
      where: {
        shopId,
        supersededAt: null,
        surfaceKind: "BASE",
        variantGid: { in: variants.map((v) => v.variantGid) },
      },
      select: { variantGid: true, basePrice: true },
    });
  };

  console.log(`${shop.domain}: ${total} variants.`);
  console.log(`\n  ${campaigns} campaigns planning the whole catalogue continuously, while`);
  console.log(
    `  ${merchants} merchant${merchants === 1 ? "" : "s"} page the catalogue. ` +
      `${WINDOW_MS / 1000}s per pool size.\n`,
  );
  console.log("   pool   admin p50   admin p95   admin max   pages   plans   pool timeouts");

  const results: Result[] = [];
  for (const pool of POOL_SIZES) {
    const result = await measurePool(
      shop.id,
      pool,
      campaigns,
      merchants,
      loadCandidates,
      catalogue,
    );
    results.push(result);
    console.log(
      `  ${String(result.pool).padStart(5)}   ` +
        `${result.admin.p50.toFixed(0).padStart(7)}ms   ` +
        `${result.admin.p95.toFixed(0).padStart(7)}ms   ` +
        `${result.admin.max.toFixed(0).padStart(7)}ms   ` +
        `${String(result.admin.count).padStart(5)}   ` +
        `${String(result.plannerRuns).padStart(5)}   ` +
        `${String(result.poolTimeouts).padStart(13)}` +
        (result.otherErrors > 0 ? `   (${result.otherErrors} other errors)` : ""),
    );
  }

  // The idle floor, for comparison. Taken last so it is not the run that warms the cache
  // for everything else.
  const idle: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = process.hrtime.bigint();
    await catalogue(observed, shop.id);
    idle.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const floor = summarise(idle);
  console.log(
    `\n  idle floor: p50 ${floor.p50.toFixed(0)}ms   p95 ${floor.p95.toFixed(0)}ms` +
      `   max ${floor.max.toFixed(0)}ms`,
  );

  const best = results.reduce((a, b) => (b.admin.p95 < a.admin.p95 ? b : a));
  console.log(
    `\n  Lowest admin p95 under load: pool ${best.pool} at ${best.admin.p95.toFixed(0)}ms ` +
      `(${(best.admin.p95 / Math.max(1, floor.p95)).toFixed(1)}x the idle floor).`,
  );

  await Promise.all([observed.$disconnect()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
