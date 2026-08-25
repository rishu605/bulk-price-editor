#!/usr/bin/env tsx
/**
 * End-to-end check of the campaign state machine, against the real store.
 *
 * Covers the three things the ticket says must be true and that a unit test cannot
 * prove on its own: a real price edit outside Anchor holds the campaign, a partial
 * run resumes to a clean state, and an illegal transition is refused rather than
 * silently applied.
 *
 *   npx tsx scripts/test-lifecycle.ts
 */

import prisma from "../app/db.server";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";
import {
  transitionCampaign,
  transitionHistory,
} from "../app/services/campaigns/lifecycle.server";
import { checkForDrift } from "../app/services/drift.server";
import { captureBaselines } from "../app/services/baselines.server";

const TAG = "anchor-lifecycle-test";
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function main() {
  const shop = await prisma.shop.findFirst({ where: { uninstalledAt: null } });
  if (!shop) throw new Error("No installed shop");
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session");

  const product = await createProduct(client);
  console.log(`shop: ${shop.domain}\nprobe: ${product.productGid} at 200.00\n`);

  // The webhook mirrors it; wait so a baseline exists to price from.
  const mirrored = await waitFor(async () => {
    const row = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId: shop.id, variantGid: product.variantGid } },
    });
    return row ?? null;
  }, 60_000);
  if (!mirrored) throw new Error("webhook never mirrored the probe product");

  // Without a baseline the campaign has nothing to compute from, so the run would
  // plan zero rows and reach ACTIVE having written nothing -- which would make the
  // resume check below pass vacuously.
  await captureBaselines(shop.id, {
    variantGids: [product.variantGid],
    source: "INSTALL_CAPTURE",
  });

  const campaign = await createCampaign(shop.id, {
    name: `Lifecycle test ${Date.now()}`,
    priority: 950,
    rule: { kind: "percent-change", percent: -25 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });

  // ------------------------------------------------- 1. apply → ACTIVE
  console.log("1. apply");
  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test: apply" });
  await runCampaign(shop.id, campaign.id, client, {});
  check("state after a clean run", await stateOf(campaign.id), "ACTIVE");
  check("the run actually wrote a row", await verifiedRows(campaign.id) > 0, true);

  // ------------------------------------------- 2. a real edit outside Anchor
  console.log("2. merchant edits the price in Shopify");
  await setPrice(client, product.variantGid, "111.11");
  // checkForDrift is what the products webhook calls before overwriting the mirror.
  const drifted = await checkForDrift(shop.id, product.variantGid, 11111n, null);
  check("drift detected", drifted, true);
  check("campaign held", await stateOf(campaign.id), "HELD");

  // ------------------------------------------------ 3. illegal transition
  console.log("3. illegal transition is refused");
  await transitionCampaign(shop.id, campaign.id, "CANCELLED", { reason: "test" });
  let refused = false;
  try {
    await transitionCampaign(shop.id, campaign.id, "ACTIVE", { reason: "test: illegal" });
  } catch {
    refused = true;
  }
  check("cancelled → active refused", refused, true);
  check("still cancelled", await stateOf(campaign.id), "CANCELLED");

  // ---------------------------------------------------- 4. resume a partial
  console.log("4. resume from partial");
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PARTIAL" } });
  await transitionCampaign(shop.id, campaign.id, "APPLYING", { reason: "test: resume" });
  await runCampaign(shop.id, campaign.id, client, {});
  check("resume reaches a clean state", await stateOf(campaign.id), "ACTIVE");

  // -------------------------------------------------------- 5. idempotence
  console.log("5. duplicate transition is a no-op, not an error");
  const again = await transitionCampaign(shop.id, campaign.id, "ACTIVE", {
    reason: "test: duplicate tick",
  });
  check("second identical transition changed nothing", again.changed, false);

  // ------------------------------------------------------- 6. audit trail
  const history = await transitionHistory(shop.id, campaign.id, 20);
  console.log(`6. audit trail has ${history.length} entries:`);
  for (const entry of history.slice(0, 6)) {
    console.log(`     ${entry.from} → ${entry.to} · ${entry.reason}`);
  }
  check("transitions were recorded", history.length > 0, true);

  // ------------------------------------------------------------- cleanup
  await runCampaign(shop.id, campaign.id, client, { revert: true }).catch(() => {});
  await prisma.driftEvent.deleteMany({ where: { variantGid: product.variantGid } });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  await client.request(
    `mutation D($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
    { input: { id: product.productGid } },
  );
  console.log("\ncleaned up");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

async function verifiedRows(campaignId: string): Promise<number> {
  const run = await prisma.campaignRun.findFirst({
    where: { campaignId, kind: "APPLY" },
    orderBy: { createdAt: "desc" },
    select: { verifiedRows: true },
  });
  return run?.verifiedRows ?? 0;
}

async function stateOf(campaignId: string): Promise<string> {
  const row = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { status: true },
  });
  return row.status;
}

async function createProduct(client: NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>) {
  const result = await client.request(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `Lifecycle probe ${Date.now()}`,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: "200.00" }],
      },
    },
  );

  const body = result as {
    data: { productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } } };
  };
  return {
    productGid: body.data.productSet.product.id,
    variantGid: body.data.productSet.product.variants.nodes[0].id,
  };
}

async function setPrice(
  client: NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>,
  variantGid: string,
  price: string,
) {
  const owner = await prisma.variantIndex.findFirstOrThrow({
    where: { variantGid },
    select: { productGid: true },
  });

  await client.request(
    `mutation Update($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { message }
       }
     }`,
    { productId: owner.productGid, variants: [{ id: variantGid, price }] },
  );
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
