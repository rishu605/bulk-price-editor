#!/usr/bin/env tsx
/**
 * Live check for #732: a market sync removes a fixed price Shopify no longer has.
 *
 * Against a real store, on a market list that already carries fixed prices:
 *   1. plants a mirror row for a variant that has no fixed price on that list -- the row our
 *      own revert used to leave behind;
 *   2. runs the real `syncMarkets` against Shopify;
 *   3. checks the planted row is gone, and that every row left for the list is one Shopify
 *      really holds as a fixed price (nothing real was swept away).
 *
 * Writes nothing to Shopify; only the local mirror.
 *
 *   npx tsx scripts/test-market-sync-stale.ts [--shop boltify-apps.myshopify.com]
 */

import prisma from "../app/db.server";
import { readFixedPriceVariants } from "../app/lib/execution/market-executor";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { syncMarkets } from "../app/services/markets-sync.server";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — open the app in the store first");

  // A list with fixed prices already mirrored, so there are real rows that must survive.
  const lists = await prisma.priceSurfaceEntry.groupBy({
    by: ["priceListGid", "surfaceKind"],
    where: { shopId: shop.id, priceListGid: { not: "" } },
    _count: true,
  });
  const target = lists.sort((a, b) => b._count - a._count)[0];
  if (!target) throw new Error("No market list with mirrored fixed prices on this store");
  const listGid = target.priceListGid;
  const before = await prisma.priceSurfaceEntry.findMany({ where: { shopId: shop.id, priceListGid: listGid } });
  console.log(`\n${shop.domain}: ${listGid}, ${before.length} mirrored fixed prices`);

  // A variant with no fixed price on that list, according to Shopify itself.
  const candidates = await prisma.variantIndex.findMany({
    where: { shopId: shop.id, deletedAt: null, variantGid: { notIn: before.map((row) => row.variantGid) } },
    select: { variantGid: true },
    take: 20,
  });
  const fixedAmongCandidates = await readFixedPriceVariants(client, listGid, candidates.map((c) => c.variantGid));
  const stale = candidates.find((c) => !fixedAmongCandidates.has(c.variantGid))?.variantGid;
  if (!stale) throw new Error("Could not find a variant without a fixed price on that list");

  await prisma.priceSurfaceEntry.create({
    data: {
      shopId: shop.id,
      variantGid: stale,
      surfaceKind: target.surfaceKind,
      priceListGid: listGid,
      currency: before[0]?.currency ?? "USD",
      livePrice: 240000n,
      syncedAt: new Date(Date.now() - 60_000),
    },
  });
  console.log(`   planted a stale fixed price for ${stale}`);

  try {
    const result = await syncMarkets(client, shop.id);
    check("the sync ran cleanly", result.errors.length === 0, result.errors.join("; "));

    const after = await prisma.priceSurfaceEntry.findMany({ where: { shopId: shop.id, priceListGid: listGid } });
    check("the planted stale row is gone", !after.some((row) => row.variantGid === stale));

    const reallyFixed = await readFixedPriceVariants(client, listGid, after.map((row) => row.variantGid));
    check(
      "every row left is a fixed price Shopify holds",
      after.every((row) => reallyFixed.has(row.variantGid)),
      `${after.length} rows, ${reallyFixed.size} fixed in Shopify`,
    );
    const stillFixed = await readFixedPriceVariants(client, listGid, before.map((row) => row.variantGid));
    const kept = new Set(after.map((row) => row.variantGid));
    check(
      "no fixed price Shopify still holds was swept away",
      [...stillFixed].every((gid) => kept.has(gid)),
      `${stillFixed.size} of ${before.length} earlier rows still fixed in Shopify, ${after.length} rows now`,
    );
  } finally {
    await prisma.priceSurfaceEntry.deleteMany({ where: { shopId: shop.id, priceListGid: listGid, variantGid: stale } });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
