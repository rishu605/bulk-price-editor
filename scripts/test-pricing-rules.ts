#!/usr/bin/env tsx
/**
 * Practice mode, guardrails and rounding, against the real Shopify API.
 *
 * All three are covered by unit tests and by chaos scenarios, and both of those talk to a
 * fake. The fake is written from the same understanding as the code, so it agrees with
 * the code about anything the code has wrong — which is how a trigger that Shopify
 * refuses outright passed every test in the repo.
 *
 * So each check here reads the price back out of Shopify rather than out of the mirror or
 * the ledger, and asserts on that. What the merchant's storefront says is the only
 * authority that matters.
 *
 *   npx tsx scripts/test-pricing-rules.ts --shop <domain>
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";
import { captureBaselines } from "../app/services/baselines.server";

const TAG = "anchor-pricing-rules-test";
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

/** The price Shopify itself reports. Never the mirror — that is the thing under test. */
async function livePrice(client: Client, variantGid: string): Promise<string> {
  return (await live(client, variantGid)).price;
}

/** Price and compare-at together, as Shopify reports them. */
async function live(
  client: Client,
  variantGid: string,
): Promise<{ price: string; compareAt: string | null }> {
  const result = await client.request<{
    productVariant: { price: string; compareAtPrice: string | null };
  }>(
    `query PricingRulesPrice($id: ID!) {
       productVariant(id: $id) { price compareAtPrice }
     }`,
    { id: variantGid },
  );
  return {
    price: result.data?.productVariant?.price ?? "",
    compareAt: result.data?.productVariant?.compareAtPrice ?? null,
  };
}

async function createProbe(client: Client, price: string) {
  const result = await client.request<{
    productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } };
  }>(
    `mutation PricingRulesCreate($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `Pricing rules probe ${Date.now()}`,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price }],
      },
    },
  );

  const product = result.data?.productSet?.product;
  if (!product) throw new Error("could not create the probe product");
  return { productGid: product.id, variantGid: product.variants.nodes[0]!.id };
}

async function waitForMirror(shopId: string, variantGid: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const row = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId, variantGid } },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("the products/create webhook never mirrored the probe");
}

async function main() {
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });

  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session");

  const probe = await createProbe(client, "200.00");
  console.log(`shop: ${shop.domain}\nprobe: ${probe.variantGid} at 200.00\n`);
  await waitForMirror(shop.id, probe.variantGid);
  await captureBaselines(shop.id, {
    variantGids: [probe.variantGid],
    source: "INSTALL_CAPTURE",
  });

  const scoped = { groups: [{ conditions: [{ field: "tag" as const, value: TAG }] }] };
  const created: string[] = [];

  // ------------------------------------------------- 1. practice mode writes nothing
  console.log("1. a practice campaign writes nothing");
  const practice = await createCampaign(shop.id, {
    name: `Practice ${Date.now()}`,
    priority: 900,
    rule: { kind: "percent-change", percent: -50 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: scoped,
    schedule: { kind: "manual", practice: true },
  } as never);
  created.push(practice.id);

  let refused = false;
  try {
    await runCampaign(shop.id, practice.id, client, {});
  } catch {
    // Refused in `runCampaign` itself rather than only in the UI, which is the point.
    refused = true;
  }
  check("applying a practice campaign is refused", refused, true);
  check("the live price is untouched", await livePrice(client, probe.variantGid), "200.00");

  // ------------------------------------------------- 2. a floor clamps the price
  console.log("2. a guardrail floor clamps rather than pricing through it");
  const floored = await createCampaign(shop.id, {
    name: `Floored ${Date.now()}`,
    priority: 910,
    // -50% would be 100.00; the floor is above that and must win.
    rule: { kind: "percent-change", percent: -50 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    // `Money.amount` is a number of minor units, not a bigint. Writing 15000n here
    // compared bigint against number in the read-back, failed a row whose price was
    // exactly right, and left the campaign PARTIAL — worth the comment, because the
    // `as never` below is what let it past the compiler.
    guardrails: { minPrice: { amount: 15000, currency: "USD" } },
    ast: scoped,
    schedule: { kind: "manual" },
  } as never);
  created.push(floored.id);

  await runCampaign(shop.id, floored.id, client, {});
  check("Shopify holds the floor, not the computed price", await livePrice(client, probe.variantGid), "150.00");
  await runCampaign(shop.id, floored.id, client, { revert: true });
  check("reverted to the baseline", await livePrice(client, probe.variantGid), "200.00");

  // ------------------------------------------------- 3. charm rounding
  console.log("3. charm rounding reaches the storefront");
  const charmed = await createCampaign(shop.id, {
    name: `Charmed ${Date.now()}`,
    priority: 920,
    // -13% of 200.00 is 174.00, which only ends .99 if rounding actually applied.
    rule: { kind: "percent-change", percent: -13 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "charm99", byCurrency: {} },
    ast: scoped,
    schedule: { kind: "manual" },
  } as never);
  created.push(charmed.id);

  await runCampaign(shop.id, charmed.id, client, {});
  const charmedPrice = await livePrice(client, probe.variantGid);
  check("the live price ends .99", charmedPrice.endsWith(".99"), true);
  console.log(`   live price: ${charmedPrice}`);
  await runCampaign(shop.id, charmed.id, client, { revert: true });
  check("reverted to the baseline", await livePrice(client, probe.variantGid), "200.00");


  // ------------------------------------------------- 4. compare-at strike-through
  console.log("4. a sale that looks like a sale");
  const struck = await createCampaign(shop.id, {
    name: `Struck ${Date.now()}`,
    priority: 930,
    rule: { kind: "percent-change", percent: -25 },
    // The baseline goes into compare-at, which is what puts the line through the old
    // price on the storefront. Without it a sale is just a lower number.
    compareAtPolicy: { kind: "set-to-baseline" },
    compareAtViolationPolicy: "clear",
    rounding: { default: "none", byCurrency: {} },
    ast: scoped,
    schedule: { kind: "manual" },
  } as never);
  created.push(struck.id);

  await runCampaign(shop.id, struck.id, client, {});
  const onSale = await live(client, probe.variantGid);
  check("the sale price", onSale.price, "150.00");
  check("compare-at carries the baseline", onSale.compareAt, "200.00");
  check("compare-at is above the price, or it is not a strike-through",
    Number(onSale.compareAt) > Number(onSale.price), true);

  await runCampaign(shop.id, struck.id, client, { revert: true });
  const ended = await live(client, probe.variantGid);
  check("price back to the baseline", ended.price, "200.00");
  // The sale is over, so the strike-through must go with it. A compare-at left behind
  // shows a permanent fake discount, which is the thing regulators care about.
  check("compare-at cleared when the sale ended", ended.compareAt, null);

  // ------------------------------------------------------------------- clean up
  for (const id of created) {
    await prisma.campaign.delete({ where: { id } }).catch(() => {});
  }
  await client.request(
    `mutation PricingRulesDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
    { input: { id: probe.productGid } },
  );
  console.log("\ncleaned up");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
