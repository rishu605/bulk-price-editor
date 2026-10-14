#!/usr/bin/env tsx
/**
 * A bulk run that stops watching Shopify, against the real store (#832).
 *
 * The chaos suite proves this against a fake that finishes when told to. This proves it
 * against a real bulk operation, which Shopify runs on its own clock:
 *
 *   A run that stops waiting after Shopify accepted its operation leaves its rows "sent
 *   to Shopify" -- not pending, not unreported -- and says how many.
 *
 *   The next run asks Shopify how that operation ended. While it is still running the
 *   run is refused; once it has finished, its result file settles every row, no second
 *   operation is sent, and the store has the campaign's prices.
 *
 * The mirror rows for the probe products are written here rather than waited for: the
 * store's product webhooks go to the deployed app unless a dev preview is running, and
 * when one is they may get there first, so either way is fine.
 *
 *   npx tsx scripts/test-bulk-in-flight.ts --shop boltify-apps.myshopify.com [--hold 90]
 *
 * `--hold` pauses that many seconds once the run has stopped, with the campaign showing
 * its sent rows, so the Runs tab and the campaigns list can be looked at in the admin.
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { captureBaselines } from "../app/services/baselines.server";
import { listCampaigns } from "../app/services/campaigns/list.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { transitionCampaign } from "../app/services/campaigns/lifecycle.server";
import { campaignResult } from "../app/services/campaigns/result.server";
import { runCampaign } from "../app/services/campaigns/run.server";

const TAG = "anchor-bulk-in-flight-test";
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

  const currency = await shopCurrency(client);
  const leftovers = await probesFromEarlierRuns(client);
  for (const productGid of leftovers) await deleteProduct(client, productGid);
  if (leftovers.length > 0) console.log(`deleted ${leftovers.length} probe product(s) a failed run left behind`);
  console.log(`shop: ${shop.domain} (${currency})\ncreating ${PRODUCTS} probe products...`);
  const products = [];
  for (let i = 0; i < PRODUCTS; i++) products.push(await createProduct(client, i));
  const variantGids = products.map((p) => p.variantGid);
  const baseline = new Map(variantGids.map((gid, i) => [gid, (100 + i) * 100]));

  await prisma.variantIndex.createMany({
    data: products.map((p) => ({
      shopId: shop.id,
      variantGid: p.variantGid,
      productGid: p.productGid,
      title: p.title,
      price: BigInt(baseline.get(p.variantGid)!),
      currency,
      status: "ACTIVE" as const,
      tags: [TAG],
    })),
    skipDuplicates: true,
  });
  await prisma.priceSurfaceEntry.createMany({
    data: variantGids.map((variantGid) => ({
      shopId: shop.id,
      variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: "",
      currency,
      livePrice: BigInt(baseline.get(variantGid)!),
    })),
    skipDuplicates: true,
  });
  await captureBaselines(shop.id, { variantGids, source: "INSTALL_CAPTURE" });

  const name = `Bulk in-flight test ${Date.now()}`;
  const campaign = await createCampaign(shop.id, {
    name,
    priority: 960,
    rule: { kind: "percent-change", percent: -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });

  try {
    // ------------------------------- 1. the run stops watching a real operation
    console.log("\n1. bulk apply that stops waiting as soon as Shopify accepts the operation");
    await transitionCampaign(shop.id, campaign.id, "APPLYING", { actor: "script", reason: "test" });
    const stopped = await runCampaign(shop.id, campaign.id, client, { actor: "script", forcePath: "bulk", bulkWaitMs: 1 }).then(
      () => null,
      (error: unknown) => error as { userMessage?: string; message?: string },
    );
    console.log(`      ${stopped?.userMessage ?? stopped?.message ?? "(the run did not stop)"}`);
    check("it says how many prices were sent", /4 prices were sent to Shopify in bulk and may already be live/.test(stopped?.userMessage ?? ""), true);

    const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: campaign.id, kind: "APPLY" } });
    const statuses = await prisma.variantChange.findMany({ where: { runId: run.id }, select: { status: true } });
    check("every row reads sent (WRITING)", statuses.filter((row) => row.status === "WRITING").length, PRODUCTS);
    const operation = await prisma.bulkOperationRecord.findFirstOrThrow({ where: { runId: run.id } });
    console.log(`      operation ${operation.shopifyGid}, recorded ${operation.status}`);

    const summary = (await campaignResult(shop.id, run.id))!.summary;
    console.log(`      summary: ${summary}`);
    check("the summary says they were sent", summary.startsWith("4 sent to Shopify"), true);
    check("the summary never says nothing was written", summary.includes("Nothing has been written"), false);
    const listed = (await listCampaigns(shop.id, { q: name, status: "", archived: false, page: 1 })).campaigns[0];
    console.log(`      list: ${JSON.stringify(listed?.lastRun?.atShopify)}`);
    const hold = Number(process.argv[process.argv.indexOf("--hold") + 1]);
    if (process.argv.includes("--hold") && hold > 0) {
      console.log(`      holding ${hold}s: /app/campaigns/${campaign.id}?tab=runs`);
      await new Promise((r) => setTimeout(r, hold * 1000));
    }

    // ------------------------------- 2. the next run asks Shopify first
    console.log("2. resume: refused while Shopify runs it, then settled from its result file");
    await transitionCampaign(shop.id, campaign.id, "APPLYING", { actor: "script", reason: "test: resume" });
    let refusals = 0;
    let resumed = await runCampaign(shop.id, campaign.id, client, { actor: "script", resume: true });
    while (resumed.refused && refusals < 30) {
      refusals++;
      if (refusals === 1) console.log(`      refused: ${resumed.refused}`);
      await new Promise((r) => setTimeout(r, 2_000));
      resumed = await runCampaign(shop.id, campaign.id, client, { actor: "script", resume: true });
    }
    console.log(`      refused ${refusals} time(s) while Shopify was still running it`);
    check("the resume went ahead once Shopify had finished", resumed.refused, undefined);

    const settled = await prisma.variantChange.findMany({ where: { runId: run.id }, select: { status: true } });
    check("every sent row settled as VERIFIED", settled.filter((row) => row.status === "VERIFIED").length, PRODUCTS);
    check(
      "no second bulk operation was sent",
      await prisma.bulkOperationRecord.count({ where: { shopId: shop.id, kind: "MUTATION", run: { campaignId: campaign.id } } }),
      1,
    );
    const live = await livePrices(client, variantGids);
    for (const gid of variantGids) {
      check(`live price of ${gid.split("/").pop()}`, live.get(gid), ((baseline.get(gid)! * 0.8) / 100).toFixed(2));
    }
    check("campaign is ACTIVE", (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "ACTIVE");
  } finally {
    // ------------------------------------------------------------ cleanup
    await runCampaign(shop.id, campaign.id, client, { actor: "script", revert: true }).catch((error) => console.log(`   revert: ${error}`));
    const reverted = await livePrices(client, variantGids);
    check("revert put every price back", variantGids.every((gid) => reverted.get(gid) === (baseline.get(gid)! / 100).toFixed(2)), true);
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

async function shopCurrency(client: Client): Promise<string> {
  const result = (await client.request(`{ shop { currencyCode } }`, {})) as { data: { shop: { currencyCode: string } } };
  return result.data.shop.currencyCode;
}

async function probesFromEarlierRuns(client: Client): Promise<string[]> {
  const result = (await client.request(`query($q: String!) { products(first: 50, query: $q) { nodes { id } } }`, {
    q: `tag:${TAG}`,
  })) as { data: { products: { nodes: Array<{ id: string }> } } };
  return result.data.products.nodes.map((node) => node.id);
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

async function createProduct(client: Client, index: number) {
  const title = `Bulk in-flight probe ${Date.now()}-${index}`;
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
