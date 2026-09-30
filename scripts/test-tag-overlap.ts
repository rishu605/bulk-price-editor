#!/usr/bin/env tsx
/**
 * Overlapping sales and their storefront tags, against the real store.
 *
 * #686 — first on, first off. The second sale finds the tag already on the product
 * because the first sale put it there; ending the first must leave the badge on a
 * product the second is still discounting, and ending the second must take it off. A
 * tag the merchant had before either sale must survive both.
 *
 * #687 — a sale underneath a higher one wins no variants, so it tags nothing. Ending the
 * higher one hands its prices over, and the lower sale's badge must come with them.
 *
 *   npx tsx scripts/test-tag-overlap.ts --shop boltify-apps.myshopify.com
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { runCampaign } from "../app/services/campaigns/run.server";

const SCOPE = "anchor-tag-overlap-test";
const KIT = "QA686";
const HIGH_KIT = "QA687-FLASH";
const LOW_KIT = "QA687-CLEARANCE";
let failures = 0;

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function main() {
  // Name the store or be told which exist: this writes real prices and tags.
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — load the app in the admin once, then retry");

  // One product the sales tag, and one the merchant had already tagged QA686.
  const plain = await createProduct(client, "plain", [SCOPE]);
  const merchants = await createProduct(client, "merchant-tagged", [SCOPE, KIT]);
  console.log(`shop: ${shop.domain}\nprobes: ${plain.productGid}, ${merchants.productGid}\n`);
  for (const probe of [plain, merchants]) await mirror(shop.id, probe);

  const campaigns: string[] = [];
  const make = async (name: string, priority: number, percent: number, kit = KIT) => {
    const created = await createCampaign(shop.id, {
      name: `${name} ${Date.now()}`,
      priority,
      rule: { kind: "percent-change", percent },
      compareAtPolicy: { kind: "leave" },
      rounding: { default: "none", byCurrency: {} },
      ast: { groups: [{ conditions: [{ field: "tag", value: SCOPE }] }] },
      schedule: { kind: "manual" },
      tagKit: [kit],
    });
    campaigns.push(created.id);
    return created.id;
  };

  try {
    const first = await make("Tag overlap A", 950, -10);
    const second = await make("Tag overlap B", 960, -15);

    console.log("1. apply A, then B over the same products");
    const a = await runCampaign(shop.id, first, client, { verifySampleRate: 1 });
    check("A applied clean", a.clean, true);
    check("A tagged the plain product", await hasTag(client, plain.productGid), true);
    const b = await runCampaign(shop.id, second, client, { verifySampleRate: 1 });
    check("B applied clean", b.clean, true);

    console.log("2. revert A first: B is still discounting both products");
    await runCampaign(shop.id, first, client, { revert: true, verifySampleRate: 1 });
    check("plain product keeps QA686 while B runs", await hasTag(client, plain.productGid), true);
    check("merchant's QA686 kept", await hasTag(client, merchants.productGid), true);
    check("B still live", await stateOf(second), "ACTIVE");

    console.log("3. revert B last: nobody owes the tag now");
    await runCampaign(shop.id, second, client, { revert: true, verifySampleRate: 1 });
    check("plain product loses QA686", await hasTag(client, plain.productGid), false);
    check("merchant's QA686 still kept", await hasTag(client, merchants.productGid), true);

    console.log("4. a higher sale over a lower one, then the higher one ends");
    const high = await make("Tag takeover high", 970, -30, HIGH_KIT);
    const low = await make("Tag takeover low", 940, -10, LOW_KIT);
    await runCampaign(shop.id, high, client, { verifySampleRate: 1 });
    await runCampaign(shop.id, low, client, { verifySampleRate: 1 });
    check("high sale's badge on", await hasTag(client, plain.productGid, HIGH_KIT), true);
    check("low sale wins nothing yet", await hasTag(client, plain.productGid, LOW_KIT), false);
    check("price is the high sale's", await priceOf(client, plain.variantGid), "140.00");

    await runCampaign(shop.id, high, client, { revert: true, verifySampleRate: 1 });
    check("price handed to the low sale", await priceOf(client, plain.variantGid), "180.00");
    check("high sale's badge off", await hasTag(client, plain.productGid, HIGH_KIT), false);
    check("low sale's badge on", await hasTag(client, plain.productGid, LOW_KIT), true);

    await runCampaign(shop.id, low, client, { revert: true, verifySampleRate: 1 });
    // Not "back to 200.00": another live campaign on the store can still leak onto the
    // probe (#752). What this step owns is that the low sale's own price is gone.
    check("low sale's price gone", (await priceOf(client, plain.variantGid)) !== "180.00", true);
    check("low sale's badge off", await hasTag(client, plain.productGid, LOW_KIT), false);
  } finally {
    for (const id of campaigns) await prisma.campaign.delete({ where: { id } }).catch(() => {});
    for (const probe of [plain, merchants]) {
      await prisma.baseline.deleteMany({ where: { shopId: shop.id, variantGid: probe.variantGid } });
      await prisma.priceSurfaceEntry.deleteMany({
        where: { shopId: shop.id, variantGid: probe.variantGid },
      });
      await prisma.variantIndex.deleteMany({ where: { shopId: shop.id, variantGid: probe.variantGid } });
      await client.request(
        `mutation TagOverlapDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
        { input: { id: probe.productGid } },
      );
    }
    console.log("\ncleaned up");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Mirrors the probe directly rather than waiting on the products webhook, which goes to
 * whichever URL the app is released at — not necessarily this process's database.
 */
async function mirror(shopId: string, probe: { productGid: string; variantGid: string }) {
  await prisma.variantIndex.upsert({
    where: { shopId_variantGid: { shopId, variantGid: probe.variantGid } },
    create: {
      shopId,
      variantGid: probe.variantGid,
      productGid: probe.productGid,
      title: `Tag overlap probe · M`,
      price: 20_000n,
      currency: "USD",
      status: "ACTIVE",
      tags: [SCOPE],
    },
    update: {},
  });
  await prisma.priceSurfaceEntry.upsert({
    where: {
      shopId_variantGid_surfaceKind_priceListGid: {
        shopId,
        variantGid: probe.variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
      },
    },
    create: {
      shopId,
      variantGid: probe.variantGid,
      surfaceKind: "BASE",
      priceListGid: "",
      currency: "USD",
      livePrice: 20_000n,
    },
    update: {},
  });
  await prisma.baseline.create({
    data: {
      shopId,
      variantGid: probe.variantGid,
      surfaceKind: "BASE",
      priceListGid: "",
      currency: "USD",
      basePrice: 20_000n,
      source: "INSTALL_CAPTURE",
    },
  });
}

async function hasTag(client: Client, productGid: string, tag = KIT): Promise<boolean> {
  const result = (await client.request(
    `query TagOverlapTags($id: ID!) { product(id: $id) { tags } }`,
    { id: productGid },
  )) as { data: { product: { tags: string[] } | null } };
  return (result.data.product?.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase());
}

async function priceOf(client: Client, variantGid: string): Promise<string | null> {
  const result = (await client.request(
    `query TagOverlapPrice($id: ID!) { productVariant(id: $id) { price } }`,
    { id: variantGid },
  )) as { data: { productVariant: { price: string } | null } };
  return result.data.productVariant?.price ?? null;
}

async function stateOf(campaignId: string): Promise<string> {
  const row = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { status: true },
  });
  return row.status;
}

async function createProduct(client: Client, label: string, tags: string[]) {
  const result = (await client.request(
    `mutation TagOverlapCreate($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `Tag overlap probe ${label} ${Date.now()}`,
        status: "ACTIVE",
        tags,
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: "200.00" }],
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

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
