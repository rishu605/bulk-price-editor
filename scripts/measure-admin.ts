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

import prisma from "../app/db.server";
import { reconcile } from "../app/services/reconciliation.server";

const PAGE_SIZE = 50;
const RUNS = 5;

/** p50 and max of a warm run, because a cold first call measures the connection. */
async function time(label: string, fn: () => Promise<unknown>): Promise<void> {
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
  console.log(`  ${label.padEnd(44)} p50 ${String(p50).padStart(5)}ms   max ${String(max).padStart(5)}ms`);
}

async function main() {
  const shop = await prisma.shop.findFirstOrThrow();
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
    await time(`    page ${page} (offset ${(page - 1) * PAGE_SIZE})`, () => catalogue(page));
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
