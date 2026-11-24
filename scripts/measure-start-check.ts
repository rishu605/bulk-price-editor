#!/usr/bin/env node
/**
 * How long the start check takes on a whole-catalogue, every-market campaign (#1175).
 *
 *   npx tsx scripts/measure-start-check.ts --shop anchor-perf [--runs 3]
 *
 * Flow's "Start a price campaign" is checked inside Flow's request, before it is handed to
 * the worker, so Flow hears a refusal rather than "queued" (#1009, D29), and Flow gives up
 * after ten seconds. Since #1171 the check plans each market's prices as well as the base
 * ones, from the market baselines already recorded, so its cost grows with the markets a
 * campaign covers. This measures the check two ways:
 *
 * - **as the store is**: market baselines only where something has recorded them. A
 *   campaign nobody previewed usually has none, so this is a scheduled or Flow start's
 *   first check.
 * - **with every market price recorded**: a market baseline for every variant on every
 *   list, which is the most the check can plan. Those rows are synthetic (the list's
 *   percentage applied to the base price at a rough exchange rate) because recording real
 *   ones asks Shopify for each derived price. The check's cost depends on how many rows it
 *   reads and plans, not on their amounts.
 *
 * It writes to the database it is pointed at, and only there: one draft campaign and, for
 * the second measurement, the synthetic baselines, all removed again in `finally`. Nothing
 * is sent to Shopify. Point it at a local copy of the store, never at production.
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { createCampaign } from "../app/services/campaigns/model.server";
import { startCheck } from "../app/services/campaigns/start-confirmation.server";

/** Marks every row this script writes, so `finally` removes exactly those. */
const MARKER = "measure-start-check";

/** Rough store-currency-to-list rates for the synthetic amounts; they don't change the timing. */
const RATE: Record<string, number> = { EUR: 0.92, JPY: 1.5, GBP: 0.79, CAD: 1.37 };

const runsArg = (args: readonly string[]): number => {
  const at = args.indexOf("--runs");
  const value = at === -1 ? 3 : Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error("--runs takes a whole number, 1 or more");
  return value;
};

async function timed(label: string, runs: number, work: () => Promise<unknown>): Promise<number[]> {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await work();
    ms.push(Math.round(performance.now() - started));
  }
  const sorted = [...ms].sort((a, b) => a - b);
  console.log(`  ${label}: ${ms.join(" ms, ")} ms (median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms)`);
  return ms;
}

async function synthesizeMarketBaselines(
  shopId: string,
  lists: Array<{ priceListGid: string; currency: string; adjustmentBps: number | null }>,
) {
  const bases = await prisma.baseline.findMany({
    where: { shopId, surfaceKind: "BASE", supersededAt: null },
    select: { variantGid: true, basePrice: true },
  });
  const recorded = new Set(
    (
      await prisma.baseline.findMany({
        where: { shopId, surfaceKind: "MARKET", supersededAt: null },
        select: { variantGid: true, priceListGid: true },
      })
    ).map((row) => `${row.priceListGid} ${row.variantGid}`),
  );

  let written = 0;
  for (const list of lists) {
    const bps = list.adjustmentBps ?? 0;
    const factor = (RATE[list.currency] ?? 1) * (1 + bps / 10_000);
    const rows = bases
      .filter((base) => !recorded.has(`${list.priceListGid} ${base.variantGid}`))
      .map((base) => ({
        shopId,
        variantGid: base.variantGid,
        surfaceKind: "MARKET" as const,
        priceListGid: list.priceListGid,
        currency: list.currency,
        basePrice: BigInt(Math.max(1, Math.round(Number(base.basePrice) * factor))),
        handSet: false,
        listAdjustmentBps: bps,
        source: "INSTALL_CAPTURE" as const,
        capturedBy: MARKER,
      }));
    for (let i = 0; i < rows.length; i += 5_000) {
      written += (await prisma.baseline.createMany({ data: rows.slice(i, i + 5_000) })).count;
    }
  }
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const runs = runsArg(args);
  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: chooseShop(installed, shopArg(args)).domain } });

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId: shop.id, surfaceKind: "MARKET" },
    select: { priceListGid: true, name: true, currency: true, adjustmentBps: true },
  });
  const variants = await prisma.variantIndex.count({ where: { shopId: shop.id } });
  console.log(`${shop.domain}: ${variants} variants, the store price and ${lists.length} market list(s): ${lists.map((l) => `${l.currency} ${(l.adjustmentBps ?? 0) / 100}%`).join(", ")}`);

  const created = await createCampaign(shop.id, {
    name: `Start check measurement ${new Date().toISOString()}`,
    priority: 990,
    rule: { kind: "percent-change", percent: -10 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [] },
    schedule: { kind: "manual" },
  });

  try {
    await prisma.campaign.update({
      where: { id: created.id },
      data: { surfaces: { base: true, priceLists: lists.map((l) => l.priceListGid) } as never },
    });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: created.id } });

    const check = () => startCheck(shop.id, campaign);
    const first = await check();
    console.log(`  the check plans ${first.radius?.planned ?? 0} base prices; asks for "apply": ${Boolean(first.unconfirmed)}`);

    console.log("As the store is (market baselines only where recorded):");
    await timed("start check", runs, check);

    console.log("With every market price recorded:");
    const written = await synthesizeMarketBaselines(shop.id, lists);
    console.log(`  wrote ${written} synthetic market baselines`);
    await timed("start check", runs, check);
  } finally {
    const removed = await prisma.baseline.deleteMany({ where: { shopId: shop.id, capturedBy: MARKER } });
    await prisma.auditLogEntry.deleteMany({ where: { shopId: shop.id, entityId: created.id } });
    await prisma.campaign.delete({ where: { id: created.id } });
    console.log(`Removed the campaign and ${removed.count} synthetic baselines.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
