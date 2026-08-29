#!/usr/bin/env node
/**
 * Times the admin pages' queries against whatever the connected store actually holds.
 *
 * Built for Shopify judges admin performance, and #66 asks the same question at 100K
 * variants. Both need a number rather than an impression, and the number is worthless
 * against an empty database — every query is fast when there is nothing to scan, which is
 * the most common way a performance check passes and tells you nothing.
 *
 *   npm run measure:admin
 *
 * Measures the queries the loaders run, not the loaders themselves. A loader needs an
 * authenticated request and gives back HTML timing dominated by the network; the queries
 * are where the shape of the data actually bites, and they are what changes when a
 * catalogue grows.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import prisma from "../app/db.server";
import {
  compare,
  comparable,
  passed,
  verdict,
  type PerfBaseline,
  type Timing,
} from "../app/lib/perf/drift";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { reconcile } from "../app/services/reconciliation.server";

const PAGE_SIZE = 50;
const RUNS = 5;

/** Where the accepted numbers live, so a later run has something to disagree with. */
const BASELINE_PATH = join(process.cwd(), "docs", "perf", "perf-baseline-admin.json");

/** Everything measured this run, in the order it was measured. */
const measured: Timing[] = [];

/**
 * p50 and max of a warm run, because a cold first call measures the connection.
 *
 * `record` is false for the offset-scaling sweep, whose labels carry the page number and
 * therefore change with the catalogue. A baseline keyed on those would report every row as
 * new after any import, which is a comparison that can never fail.
 */
async function time(label: string, fn: () => Promise<unknown>, record = true): Promise<void> {
  await fn();

  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = Date.now();
    await fn();
    runs.push(Date.now() - started);
  }
  runs.sort((a, b) => a - b);

  const p50 = runs[Math.floor(runs.length / 2)];
  const max = runs[runs.length - 1];
  if (record) measured.push({ label: label.trim(), p50, max });
  console.log(`  ${label.padEnd(44)} p50 ${String(p50).padStart(5)}ms   max ${String(max).padStart(5)}ms`);
}

async function main() {
  const args = process.argv.slice(2);

  // Name the store or be told which exist. These scripts write real prices to a real
  // storefront, so guessing is the one behaviour not on offer — the same rule the seeder
  // and the perf scripts already follow.
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(args)).domain },
  });
  const total = await prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } });
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  console.log(`${shop.domain}: ${total} variants, ${lastPage} pages of ${PAGE_SIZE}.\n`);

  const where = { shopId: shop.id, deletedAt: null };

  const catalogue = async (page: number) => {
    const variants = await prisma.variantIndex.findMany({
      where,
      orderBy: [{ title: "asc" }, { variantGid: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    await prisma.baseline.findMany({
      where: {
        shopId: shop.id,
        supersededAt: null,
        surfaceKind: "BASE",
        variantGid: { in: variants.map((v) => v.variantGid) },
      },
      select: { variantGid: true, basePrice: true },
    });
  };

  await time("catalogue, first page", () => catalogue(1));
  await time("catalogue, last page", () => catalogue(lastPage));

  await time("catalogue, text search", async () => {
    const filtered = {
      ...where,
      OR: [
        { title: { contains: "jacket", mode: "insensitive" as const } },
        { sku: { contains: "jacket", mode: "insensitive" as const } },
      ],
    };
    await Promise.all([
      prisma.variantIndex.count({ where: filtered }),
      prisma.variantIndex.findMany({ where: filtered, orderBy: [{ title: "asc" }], take: PAGE_SIZE }),
    ]);
  });

  await time("reconciliation, first page", () => reconcile(shop.id, shop.domain, {}, 1));
  await time("reconciliation, deep page", () =>
    reconcile(shop.id, shop.domain, {}, Math.min(20, lastPage)),
  );

  // The trend, not just the endpoints.
  //
  // Offset pagination costs roughly O(offset), and on a small catalogue that curve
  // flattens once the table is cached — which reads like "this is fine" and is not the
  // same statement. Printing the shape makes the difference visible instead of leaving it
  // to be inferred from two numbers.
  console.log("\n  offset scaling");
  for (const fraction of [0, 0.15, 0.4, 0.7, 0.99]) {
    const page = Math.max(1, Math.round(lastPage * fraction));
    await time(`    page ${page} (offset ${(page - 1) * PAGE_SIZE})`, () => catalogue(page), false);
  }

  await reportDrift(shop.domain, total, args.includes("--record"));

  await prisma.$disconnect();
}

/**
 * What moved since the numbers on record, and whether that is acceptable.
 *
 * The whole point of the file this reads. `docs/perf/README.md` said reconciliation took
 * 7ms while it took 1,006ms, for days, because a recorded number and a measured one had no
 * relationship — and the regression was invisible to every other check, having grown with
 * ledger size rather than catalogue size.
 */
async function reportDrift(shop: string, variants: number, record: boolean): Promise<void> {
  const now: PerfBaseline = {
    recordedAt: new Date().toISOString(),
    shop,
    variants,
    timings: measured,
  };

  if (record) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`\n  recorded ${measured.length} timings to ${BASELINE_PATH}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log(`\n  no baseline on record — run again with --record to accept these numbers`);
    return;
  }

  const recorded = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as PerfBaseline;

  const incomparable = comparable(recorded, now);
  if (incomparable) {
    // Not a failure. A different store or a resized catalogue is a change of subject, and
    // reporting it as a regression is the first false alarm that teaches somebody to pass
    // --record without reading.
    console.log(`\n  not comparable: ${incomparable}`);
    console.log(`  the numbers above stand on their own; --record to make them the baseline`);
    return;
  }

  console.log(`\n  against ${recorded.recordedAt}:`);
  const lines = verdict(compare(recorded.timings, measured));
  for (const line of lines) console.log(`  ${line}`);

  if (!passed(lines)) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
