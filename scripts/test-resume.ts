#!/usr/bin/env tsx
/**
 * Resume and poison-row behaviour against the real store.
 *
 * Two things a unit test cannot prove, because both depend on the ledger and on
 * Shopify actually rejecting something:
 *
 *   A resume re-plans only non-verified rows -- so the second pass writes far fewer
 *   rows than the first, and the prices already correct are left exactly as they are.
 *
 *   A poison row does not block the run. One variant deleted mid-run is recorded as
 *   skipped, the rest still get their prices, and the run ends partial rather than
 *   failed.
 *
 *   npx tsx scripts/test-resume.ts
 */

import prisma from "../app/db.server";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";
import { transitionCampaign } from "../app/services/campaigns/lifecycle.server";
import { captureBaselines } from "../app/services/baselines.server";

const TAG = "anchor-resume-test";
const PRODUCTS = 6;
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

async function main() {
  const shop = await prisma.shop.findFirstOrThrow({ where: { uninstalledAt: null } });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — open the app in the store first");

  console.log(`shop: ${shop.domain}\ncreating ${PRODUCTS} probe products...`);
  const products = [];
  for (let i = 0; i < PRODUCTS; i++) products.push(await createProduct(client, i));

  const variantGids = products.map((p) => p.variantGid);
  await waitForMirror(shop.id, variantGids);
  await captureBaselines(shop.id, { variantGids, source: "INSTALL_CAPTURE" });

  const campaign = await createCampaign(shop.id, {
    name: `Resume test ${Date.now()}`,
    priority: 960,
    rule: { kind: "percent-change", percent: -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: "none",
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });

  // --------------------------------------- 1. clean apply, for reference
  console.log("\n1. clean apply (the state a resumed run must converge on)");
  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test" });
  const first = await runCampaign(shop.id, campaign.id, client, {});
  check("all rows verified", first.verified, PRODUCTS);
  check("run is clean", first.clean, true);

  const reference = await livePrices(client, variantGids);
  console.log(`      reference prices: ${[...reference.values()].join(", ")}`);

  // Back to baseline so the next apply has real work to do.
  await runCampaign(shop.id, campaign.id, client, { revert: true });

  // ------------------------------- 2. an apply genuinely interrupted partway
  console.log("2. apply interrupted after 2 products");
  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test: partial" });

  const partial = await runCampaign(shop.id, campaign.id, failAfter(client, 2), {});
  console.log(`      verified ${partial.verified}, failed ${partial.failed}`);
  check("the run is not reported clean", partial.clean, false);
  check("some rows landed", partial.verified > 0, true);
  check("some rows did not", partial.verified < PRODUCTS, true);
  check("campaign is PARTIAL, not ACTIVE", await stateOf(campaign.id), "PARTIAL");

  // ------------------------------------------------- 3. resume the rest
  console.log("3. resume");
  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test: resume" });
  const resumed = await runCampaign(shop.id, campaign.id, client, { resume: true });
  console.log(`      ${resumed.messages[0] ?? "(no resume message)"}`);
  check(
    "resume wrote only what was outstanding",
    resumed.verified === PRODUCTS - partial.verified,
    true,
  );

  const afterResume = await livePrices(client, variantGids);
  const converged = variantGids.every((gid) => afterResume.get(gid) === reference.get(gid));
  check("resumed store matches the clean run exactly", converged, true);
  if (!converged) {
    for (const gid of variantGids) {
      console.log(`      ${gid}: ${afterResume.get(gid)} vs ${reference.get(gid)}`);
    }
  }

  // ------------------------------- 4. a poison row does not block the rest
  console.log("4. delete a variant, then apply — the poison row must not block");
  await runCampaign(shop.id, campaign.id, client, { revert: true });

  const victim = products[0];
  // Deleted in Shopify but still in our mirror: exactly the mid-run deletion of E4,
  // since the products/delete webhook has not arrived yet.
  await deleteProduct(client, victim.productGid);

  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test: poison" });
  const poisoned = await runCampaign(shop.id, campaign.id, client, {});
  console.log(`      verified ${poisoned.verified}, failed ${poisoned.failed}`);
  check("every surviving row still got written", poisoned.verified, PRODUCTS - 1);

  const deletedRow = await prisma.variantChange.findFirst({
    where: { runId: poisoned.runId, variantGid: victim.variantGid },
    select: { status: true, failureReason: true },
  });
  console.log(`      deleted variant: ${deletedRow?.status} — ${deletedRow?.failureReason ?? ""}`);
  check("deleted variant recorded as SKIPPED, not FAILED", deletedRow?.status, "SKIPPED");

  // ------------------------------------------------------------ cleanup
  await runCampaign(shop.id, campaign.id, client, { revert: true }).catch(() => {});
  await prisma.campaign.delete({ where: { id: campaign.id } });
  for (const product of products.slice(1)) {
    await deleteProduct(client, product.productGid).catch(() => {});
  }
  console.log("\ncleaned up");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Wraps the real client so it refuses after `products` variant writes.
 *
 * A genuine interruption -- the writes before it really happened in Shopify, which is
 * what makes the convergence check meaningful rather than a simulation.
 */
function failAfter(client: Client, products: number): Client {
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

async function stateOf(campaignId: string): Promise<string> {
  const row = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { status: true },
  });
  return row.status;
}

async function createProduct(client: Client, index: number) {
  const result = (await client.request(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `Resume probe ${Date.now()}-${index}`,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [
          { optionValues: [{ optionName: "Size", name: "M" }], price: `${100 + index}.00` },
        ],
      },
    },
  )) as {
    data: { productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } } };
  };

  return {
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

async function waitForMirror(shopId: string, variantGids: string[]) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const count = await prisma.variantIndex.count({
      where: { shopId, variantGid: { in: variantGids }, deletedAt: null },
    });
    if (count === variantGids.length) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("webhooks never mirrored every probe product");
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
