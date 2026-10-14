#!/usr/bin/env tsx
/**
 * Edits to a held campaign's prices, through Shopify's own webhooks (#878).
 *
 * Needs a running dev preview (`shopify app dev`): that is what points the store's
 * products/update webhook at this machine, so each edit below reaches the real handler.
 *
 *   Applies a campaign over two probe products, then edits the first one's price twice and
 *   the second one's once, in Shopify. The first edit holds the campaign; the drift queue
 *   must then follow the second edit and record the third.
 *
 * Probe products only; the campaign is reverted and everything deleted at the end.
 *
 *   npx tsx scripts/test-held-drift.ts --shop boltify-apps.myshopify.com
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { captureBaselines } from "../app/services/baselines.server";
import { transitionCampaign } from "../app/services/campaigns/lifecycle.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";

const TAG = "anchor-held-drift-test";
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

async function main() {
  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — open the app in the store first");

  for (const productGid of await probesFromEarlierRuns(client)) await deleteProduct(client, productGid);

  console.log(`shop: ${shop.domain}`);
  const products = [await createProduct(client, 0), await createProduct(client, 1)];
  const variantGids = products.map((p) => p.variantGid);
  await prisma.variantIndex.createMany({
    data: products.map((p, i) => ({
      shopId: shop.id,
      variantGid: p.variantGid,
      productGid: p.productGid,
      title: p.title,
      price: BigInt((100 + i) * 100),
      currency: "USD",
      status: "ACTIVE" as const,
      tags: [TAG],
    })),
    skipDuplicates: true,
  });
  await prisma.priceSurfaceEntry.createMany({
    data: variantGids.map((variantGid, i) => ({
      shopId: shop.id,
      variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: "",
      currency: "USD",
      livePrice: BigInt((100 + i) * 100),
    })),
    skipDuplicates: true,
  });
  await captureBaselines(shop.id, { variantGids, source: "INSTALL_CAPTURE" });

  const campaign = await createCampaign(shop.id, {
    name: `Held drift test ${Date.now()}`,
    priority: 960,
    rule: { kind: "percent-change", percent: -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });
  const status = async () => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status;
  const pendingFor = (variantGid: string) =>
    prisma.driftEvent.findMany({ where: { shopId: shop.id, variantGid, resolution: "PENDING" }, select: { observedPrice: true, campaignId: true } });

  try {
    console.log("\n1. apply");
    await transitionCampaign(shop.id, campaign.id, "APPLYING", { actor: "script", reason: "test" });
    check("both prices verified", (await runCampaign(shop.id, campaign.id, client, { actor: "script" })).verified, 2);

    console.log("2. edit the first price in Shopify: the campaign is held");
    // Straight after the run: the mirror is stamped on Shopify's clock, so an edit a second
    // later is newer however our clock and Shopify's disagree (#932).
    await setPrice(client, products[0], "75.00");
    await until(async () => (await status()) === "HELD", "the first edit to hold the campaign");
    check("campaign held", await status(), "HELD");

    console.log("3. edit it again");
    await setPrice(client, products[0], "70.00");
    await until(async () => (await pendingFor(variantGids[0]))[0]?.observedPrice === 7000n, "the second edit to reach the event");
    const first = await pendingFor(variantGids[0]);
    check("one pending event for the first variant", first.length, 1);
    check("it shows the price the storefront shows now", Number(first[0]?.observedPrice) / 100, 70);

    console.log("4. edit the second variant of the held campaign");
    await setPrice(client, products[1], "71.00");
    await until(async () => (await pendingFor(variantGids[1])).length > 0, "the edit to the second variant to be recorded");
    const second = await pendingFor(variantGids[1]);
    check("an event for the second variant", second.length, 1);
    check("against the held campaign", second[0]?.campaignId, campaign.id);
    check(
      "edits the Apply dialog says it would write over",
      await prisma.driftEvent.count({ where: { shopId: shop.id, campaignId: campaign.id, resolution: "PENDING" } }),
      2,
    );
    check("still held", await status(), "HELD");
  } finally {
    await prisma.driftEvent.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.baseline.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.priceSurfaceEntry.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.variantIndex.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    for (const product of products) await deleteProduct(client, product.productGid).catch(() => {});
    console.log("\ncleaned up");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Waits for a webhook's effect, which arrives in seconds but not instantly. */
async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`      (gave up waiting for ${what})`);
}

async function setPrice(client: Client, product: { productGid: string; variantGid: string }, price: string) {
  const result = (await client.request(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
     }`,
    { productId: product.productGid, variants: [{ id: product.variantGid, price }] },
  )) as { data: { productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } } };
  const errors = result.data.productVariantsBulkUpdate.userErrors;
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
}

async function probesFromEarlierRuns(client: Client): Promise<string[]> {
  const result = (await client.request(`query($q: String!) { products(first: 50, query: $q) { nodes { id } } }`, {
    q: `tag:${TAG}`,
  })) as { data: { products: { nodes: Array<{ id: string }> } } };
  return result.data.products.nodes.map((node) => node.id);
}

async function createProduct(client: Client, index: number) {
  const title = `Held drift probe ${Date.now()}-${index}`;
  const result = (await client.request(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: `${100 + index}.00` }],
      },
    },
  )) as { data: { productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } } } };
  return {
    title,
    productGid: result.data.productSet.product.id,
    variantGid: result.data.productSet.product.variants.nodes[0].id,
  };
}

async function deleteProduct(client: Client, productGid: string) {
  await client.request(
    `mutation D($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
    { input: { id: productGid } },
  );
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
