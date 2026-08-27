#!/usr/bin/env tsx
/**
 * Overlapping campaigns, against the real Shopify API.
 *
 * This is the product's central claim, and the one the help centre states plainly: "one
 * winner per product, never stacked", and "reverting recomputes rather than restoring
 * saved numbers — if another campaign still covers a variant, that campaign's price stays
 * in place".
 *
 * Both are property-tested against the resolver and exercised in chaos scenarios, and
 * both of those talk to a fake. So this asserts them against the price Shopify itself
 * reports, which is the only place a merchant's customer ever looks.
 *
 * The discounts are deliberately chosen so no two possible answers collide: -10% and -40%
 * of 200.00 are 180.00 and 120.00, and a stacked result would be 108.00 — three distinct
 * numbers, so the assertion cannot pass by coincidence.
 *
 *   npx tsx scripts/test-resolution.ts --shop <domain>
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";
import { captureBaselines } from "../app/services/baselines.server";

const TAG = "anchor-resolution-test";
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

async function livePrice(client: Client, variantGid: string): Promise<string> {
  const result = await client.request<{ productVariant: { price: string } }>(
    `query ResolutionPrice($id: ID!) { productVariant(id: $id) { price } }`,
    { id: variantGid },
  );
  return result.data?.productVariant?.price ?? "";
}

async function createProbe(client: Client, price: string) {
  const result = await client.request<{
    productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } };
  }>(
    `mutation ResolutionCreate($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `Resolution probe ${Date.now()}`,
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

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const row = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId: shop.id, variantGid: probe.variantGid } },
    });
    if (row) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await captureBaselines(shop.id, {
    variantGids: [probe.variantGid],
    source: "INSTALL_CAPTURE",
  });

  const scoped = { groups: [{ conditions: [{ field: "tag" as const, value: TAG }] }] };
  const base = {
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: scoped,
    schedule: { kind: "manual" },
  };

  const quiet = await createCampaign(shop.id, {
    ...base,
    name: `Background 10 ${Date.now()}`,
    priority: 100,
    rule: { kind: "percent-change", percent: -10 },
  } as never);

  const loud = await createCampaign(shop.id, {
    ...base,
    name: `Flash 40 ${Date.now()}`,
    priority: 900,
    rule: { kind: "percent-change", percent: -40 },
  } as never);

  // ------------------------------------------- 1. the lower-priority campaign alone
  console.log("1. one campaign covering the variant");
  await runCampaign(shop.id, quiet.id, client, {});
  check("priced by the only campaign", await livePrice(client, probe.variantGid), "180.00");

  // ------------------------------------------- 2. the higher-priority one takes over
  console.log("2. a higher-priority campaign covers the same variant");
  await runCampaign(shop.id, loud.id, client, {});
  // 108.00 would be the two stacked. It must not appear.
  check("exactly one winner, not both", await livePrice(client, probe.variantGid), "120.00");

  // --------------------------- 3. ending the winner recomputes, it does not restore
  console.log("3. ending the winner while the other still covers it");
  await runCampaign(shop.id, loud.id, client, { revert: true });
  // The claim: not 200.00 (the baseline, which a restore would give) and not 120.00.
  check(
    "falls back to the remaining campaign, not to the baseline",
    await livePrice(client, probe.variantGid),
    "180.00",
  );

  // ------------------------------------------- 4. ending the last one reaches baseline
  console.log("4. ending the last campaign");
  await runCampaign(shop.id, quiet.id, client, { revert: true });
  check("back to the baseline", await livePrice(client, probe.variantGid), "200.00");

  // ------------------------------------------------------------------- clean up
  for (const id of [quiet.id, loud.id]) {
    await prisma.campaign.delete({ where: { id } }).catch(() => {});
  }
  await client.request(
    `mutation ResolutionDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
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
