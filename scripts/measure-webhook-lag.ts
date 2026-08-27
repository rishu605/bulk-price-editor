#!/usr/bin/env tsx
/**
 * How long a merchant's price edit takes to reach the mirror.
 *
 * The NFR is p95 under 30 seconds, and it is the number that decides whether planning a
 * campaign against the mirror is safe. A campaign scoped a minute after somebody edits a
 * price is planning against whatever the mirror knew then — so this is not a vanity
 * metric, it is the width of the window in which the app can be wrong about a store.
 *
 * Measured the way a merchant produces it: edit the price through the Admin API without
 * recording a write intent, so the resulting webhook is indistinguishable from a person
 * doing it in the Shopify admin, then poll the mirror until it agrees.
 *
 * Every price is put back afterwards, including on failure.
 *
 *   npx tsx scripts/measure-webhook-lag.ts --shop anchor-perf [--edits 20]
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

const POLL_MS = 250;
const GIVE_UP_MS = 120_000;

function numberArg(args: readonly string[], flag: string, fallback: number): number {
  const at = args.indexOf(flag);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

async function setPrice(client: Client, productGid: string, variantGid: string, price: string) {
  const result = await client.request<{
    productVariantsBulkUpdate: { userErrors: Array<{ message: string }> };
  }>(
    `mutation LagSetPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { message }
       }
     }`,
    { productId: productGid, variants: [{ id: variantGid, price }] },
  );

  const errors = result.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

/** Waits for the mirror to hold `expected`, returning how long that took. */
async function waitForMirror(
  shopId: string,
  variantGid: string,
  expected: bigint,
): Promise<number | null> {
  const started = Date.now();

  while (Date.now() - started < GIVE_UP_MS) {
    const row = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId, variantGid } },
      select: { price: true },
    });
    if (row?.price === expected) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(args)).domain },
  });

  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session");

  const edits = numberArg(args, "--edits", 20);
  const variants = await prisma.variantIndex.findMany({
    where: { shopId: shop.id, deletedAt: null, price: { not: null } },
    select: { variantGid: true, productGid: true, price: true, title: true },
    orderBy: { variantGid: "asc" },
    take: edits,
  });

  if (variants.length === 0) throw new Error("no mirrored variants to edit");
  console.log(`${shop.domain}: measuring ${variants.length} edits\n`);

  const lags: number[] = [];
  let lost = 0;

  for (const [index, variant] of variants.entries()) {
    const original = variant.price!;
    // A pound up, then back. Small enough to be obviously a test edit if anybody looks
    // at the store, large enough that the mirror cannot match by rounding.
    const bumped = original + 100n;

    try {
      await setPrice(client, variant.productGid, variant.variantGid, minorToDecimal(bumped));
      const lag = await waitForMirror(shop.id, variant.variantGid, bumped);

      if (lag === null) {
        lost++;
        console.log(`  ${index + 1}/${variants.length}  never arrived within ${GIVE_UP_MS / 1000}s`);
      } else {
        lags.push(lag);
        console.log(`  ${index + 1}/${variants.length}  ${lag} ms`);
      }
    } finally {
      await setPrice(client, variant.productGid, variant.variantGid, minorToDecimal(original));
      // Let the restoring webhook land before the next edit, so a slow one is not
      // attributed to the following measurement.
      await waitForMirror(shop.id, variant.variantGid, original);
    }
  }

  const sorted = [...lags].sort((a, b) => a - b);
  console.log("");
  console.log(`delivered   ${lags.length} of ${variants.length}${lost ? ` (${lost} never arrived)` : ""}`);
  if (sorted.length) {
    console.log(`p50         ${percentile(sorted, 0.5)} ms`);
    console.log(`p95         ${percentile(sorted, 0.95)} ms   budget 30000 ms`);
    console.log(`max         ${sorted[sorted.length - 1]} ms`);
  }

  const met = lost === 0 && sorted.length > 0 && percentile(sorted, 0.95) < 30_000;
  console.log(met ? "\nPASS  p95 within the 30s budget" : "\nFAIL  budget not met");
  process.exitCode = met ? 0 : 1;
}

/** Minor units to the decimal string Shopify's price field expects. */
function minorToDecimal(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${negative ? "-" : ""}${whole}.${cents.toString().padStart(2, "0")}`;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
