#!/usr/bin/env tsx
/**
 * End-to-end check for auto-enrolment, against the real store.
 *
 * Creates a live campaign, applies it, then creates a brand-new product inside its
 * scope and waits for Shopify's own webhook to deliver. Nothing here simulates the
 * webhook: the point is to prove the real delivery path captures a baseline before
 * the price is written, which is the invariant that makes re-runs safe.
 *
 *   npx tsx scripts/test-auto-enroll.ts
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";
import { tick } from "../app/services/scheduler.server";

const TAG = "anchor-autoenroll-test";
const BASE_PRICE = "200.00";
const EXPECTED_AFTER_30_PERCENT_OFF = "140.00";

async function main() {
  // Name the store or be told which exist. These scripts write real prices to a real
  // storefront, so guessing is the one behaviour not on offer — the same rule the seeder
  // and the perf scripts already follow.
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  if (!shop) throw new Error("No installed shop");

  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error(`No usable session for ${shop.domain}`);

  console.log(`shop: ${shop.domain}\n`);

  // ---------------------------------------------------------------- 1. campaign
  const campaign = await createCampaign(shop.id, {
    name: `Auto-enroll test ${new Date().toISOString()}`,
    priority: 900, // outrank anything else left over from earlier testing
    rule: { kind: "percent-change", percent: -30 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "ACTIVE", autoEnroll: true },
  });
  console.log(`1. campaign ${campaign.id} created and ACTIVE (-30% on #${TAG})`);

  // ------------------------------------------------------- 2. new product live
  const handle = `anchor-autoenroll-${Date.now()}`;
  const created = await client.request(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id title variants(first: 5) { nodes { id price } } }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title: `Auto-enroll probe ${handle}`,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [
          { optionValues: [{ optionName: "Size", name: "M" }], price: BASE_PRICE },
        ],
      },
    },
  );

  const body = created as {
    data?: {
      productSet?: {
        product: { id: string; variants: { nodes: Array<{ id: string; price: string }> } };
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const errs = body.data?.productSet?.userErrors ?? [];
  if (errs.length) throw new Error(`productSet failed: ${JSON.stringify(errs)}`);

  const product = body.data!.productSet!.product;
  const variantGid = product.variants.nodes[0].id;
  console.log(`2. created ${product.id} at ${BASE_PRICE}, variant ${variantGid}`);

  // ------------------------------------------- 3. wait for the real webhook
  console.log("3. waiting for products/create webhook...");
  const enrolled = await waitFor(async () => {
    const row = await prisma.campaign.findUnique({
      where: { id: campaign.id },
      select: { enrollPendingAt: true },
    });
    const mirrored = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId: shop.id, variantGid } },
      select: { price: true },
    });
    return row?.enrollPendingAt && mirrored ? { at: row.enrollPendingAt } : null;
  }, 60_000);

  if (!enrolled) throw new Error("webhook never enrolled the variant (60s)");
  console.log(`   enrolled at ${enrolled.at.toISOString()}`);

  // ------------------------------------------- 4. baseline BEFORE any pricing
  const baseline = await prisma.baseline.findFirst({
    where: { shopId: shop.id, variantGid, supersededAt: null },
  });
  if (!baseline) throw new Error("no baseline captured -- E6 violated");
  console.log(
    `4. baseline ${baseline.basePrice} (source ${baseline.source}) captured before pricing`,
  );
  // The whole point: the baseline must be the ORIGINAL 200.00, not a sale price. If
  // enrolment ever captured after pricing, this would read 14000 and every re-run
  // would discount the discount.
  if (String(baseline.basePrice) !== "20000") {
    throw new Error(`baseline anchored to the wrong value: ${baseline.basePrice}`);
  }

  // ------------------------------------------------------ 5. scheduler applies
  const result = await tick();
  console.log(
    `5. tick: applied ${result.applied}, reverted ${result.reverted}, ` +
      `enrolled ${result.enrolled}, failed ${result.failures.length}`,
  );
  for (const f of result.failures) console.error(`   FAIL ${f.campaignId}: ${f.error}`);

  // -------------------------------------------------- 6. verify against Shopify
  const check = await client.request(
    `query($id: ID!) { productVariant(id: $id) { price compareAtPrice } }`,
    { id: variantGid },
  );
  const live = (check as { data: { productVariant: { price: string } } }).data
    .productVariant;
  console.log(`6. live price in Shopify: ${live.price}`);

  const pass = live.price === EXPECTED_AFTER_30_PERCENT_OFF;
  console.log(
    pass
      ? `\nPASS -- new product auto-enrolled and priced ${BASE_PRICE} -> ${live.price}`
      : `\nFAIL -- expected ${EXPECTED_AFTER_30_PERCENT_OFF}, got ${live.price}`,
  );

  // ---------------------------------------------- 7. idempotency of the re-run
  const second = await tick();
  console.log(
    `7. second tick (nothing pending): enrolled ${second.enrolled} -- expect 0`,
  );

  // ------------------------------------------------------------ 8. clean up
  await runCampaign(shop.id, campaign.id, client, { revert: true });
  await client.request(
    `mutation Del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`,
    { input: { id: product.id } },
  );
  await prisma.campaign.delete({ where: { id: campaign.id } });
  console.log("8. reverted, product deleted, campaign removed");

  process.exit(pass && second.enrolled === 0 ? 0 : 1);
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
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
