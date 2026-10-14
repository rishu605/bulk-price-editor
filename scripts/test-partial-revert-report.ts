#!/usr/bin/env tsx
/**
 * The rollback report after a revert that stopped part-way, against the real store (#910).
 *
 * Applies a campaign over four probe products, then reverts it through a client that
 * refuses every write after the second product -- a genuine partial revert: two prices
 * really are back in Shopify, two really are still on sale. The report must count none of
 * them as edited, and a hand edit made afterwards must still count.
 *
 * `--hold <seconds>` pauses with the campaign in that state so its header can be looked at
 * in the admin (through a dev preview): it should offer Resume revert / Revert, not
 * "Review N edited before reverting".
 *
 *   npx tsx scripts/test-partial-revert-report.ts --shop boltify-apps.myshopify.com [--hold 120]
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { captureBaselines } from "../app/services/baselines.server";
import { transitionCampaign } from "../app/services/campaigns/lifecycle.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { rollbackReport } from "../app/services/campaigns/rollback-report.server";
import { runCampaign } from "../app/services/campaigns/run.server";

const TAG = "anchor-partial-revert-report-test";
const PRODUCTS = 4;
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
  const products = [];
  for (let i = 0; i < PRODUCTS; i++) products.push(await createProduct(client, i));
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
    name: `Partial revert report test ${Date.now()}`,
    priority: 960,
    rule: { kind: "percent-change", percent: -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });

  try {
    console.log("\n1. apply");
    await transitionCampaign(shop.id, campaign.id, "APPLYING", { actor: "script", reason: "test" });
    check("every price verified", (await runCampaign(shop.id, campaign.id, client, { actor: "script" })).verified, PRODUCTS);

    console.log("2. revert, refused after two products");
    const partial = await runCampaign(shop.id, campaign.id, refuseAfter(client, 2), { actor: "script", revert: true }).catch(
      (error: unknown) => ({ clean: false, verified: -1, error }),
    );
    console.log(`      revert verified ${partial.verified}, clean ${partial.clean}`);
    const live = await livePrices(client, variantGids);
    const restored = variantGids.filter((gid, i) => live.get(gid) === `${100 + i}.00`);
    console.log(`      ${restored.length} of ${PRODUCTS} prices back in Shopify`);
    check("the revert stopped part-way", restored.length > 0 && restored.length < PRODUCTS, true);
    check("campaign is Partial", (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "PARTIAL");

    const report = await rollbackReport(shop.id, campaign.id);
    console.log(`      report: ${JSON.stringify(report.counts)}`);
    check("none of the revert's own restored prices read as edited", report.counts.drifted, 0);
    check("the header offers Revert / Resume, not Review", report.straightforward, true);

    const hold = Number(process.argv[process.argv.indexOf("--hold") + 1]);
    if (process.argv.includes("--hold") && hold > 0) {
      console.log(`      holding ${hold}s: /app/campaigns/${campaign.id}`);
      await new Promise((r) => setTimeout(r, hold * 1000));
    }

    console.log("3. a real edit to a price the revert restored");
    await setPrice(client, products[variantGids.indexOf(restored[0])], "55.00");
    await prisma.priceSurfaceEntry.updateMany({
      where: { shopId: shop.id, variantGid: restored[0], surfaceKind: "BASE", priceListGid: "" },
      data: { livePrice: 5500n },
    });
    const after = await rollbackReport(shop.id, campaign.id);
    check("the hand edit is drift", after.counts.drifted, 1);
  } finally {
    await runCampaign(shop.id, campaign.id, client, { actor: "script", revert: true }).catch(() => {});
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.driftEvent.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.baseline.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.priceSurfaceEntry.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    await prisma.variantIndex.deleteMany({ where: { shopId: shop.id, variantGid: { in: variantGids } } });
    for (const product of products) await deleteProduct(client, product.productGid).catch(() => {});
    console.log("\ncleaned up");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** The real client, refusing price writes after `products` of them: a revert that stops part-way. */
function refuseAfter(client: Client, products: number): Client {
  let writes = 0;
  return {
    async request<T>(query: string, variables: Record<string, unknown>) {
      if (query.includes("productVariantsBulkUpdate")) {
        if (writes >= products) throw new Error("fetch failed");
        writes++;
      }
      return client.request<T>(query, variables);
    },
  };
}

async function livePrices(client: Client, variantGids: string[]) {
  const result = (await client.request(
    `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price } } }`,
    { ids: variantGids },
  )) as { data: { nodes: Array<{ id: string; price: string } | null> } };
  const prices = new Map<string, string>();
  for (const node of result.data.nodes) if (node) prices.set(node.id, node.price);
  return prices;
}

async function setPrice(client: Client, product: { productGid: string; variantGid: string }, price: string) {
  await client.request(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
     }`,
    { productId: product.productGid, variants: [{ id: product.variantGid, price }] },
  );
}

async function probesFromEarlierRuns(client: Client): Promise<string[]> {
  const result = (await client.request(`query($q: String!) { products(first: 50, query: $q) { nodes { id } } }`, {
    q: `tag:${TAG}`,
  })) as { data: { products: { nodes: Array<{ id: string }> } } };
  return result.data.products.nodes.map((node) => node.id);
}

async function createProduct(client: Client, index: number) {
  const title = `Partial revert probe ${Date.now()}-${index}`;
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
