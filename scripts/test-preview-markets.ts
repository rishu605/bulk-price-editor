#!/usr/bin/env tsx
/**
 * A never-applied campaign's preview prices every percentage market, against the real
 * store (#840).
 *
 * Before the fix, the preview loaded markets without their country and read a percentage
 * list's own prices, which Shopify answers in the shop's currency. Every such market was
 * refused as "not converted" until the campaign's first apply stored a baseline. This
 * previews a campaign that has never been applied, so nothing stored can answer for it.
 *
 * A market can still be refused for a real reason: a country whose market does not sell in
 * local currency gets the shop's currency from Shopify itself. So a refusal passes only
 * when Shopify, asked directly, quotes that country in a different currency too -- the
 * same answer the run would get.
 *
 * Read-only against the store: it previews, never applies, and deletes its campaign.
 *
 *   npx tsx scripts/test-preview-markets.ts --shop boltify-apps.myshopify.com
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { createCampaign } from "../app/services/campaigns/model.server";
import { previewCampaign } from "../app/services/campaigns/preview.server";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function main() {
  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — open the app in the store first");

  const shopCurrency = (await prisma.variantIndex.findFirst({ where: { shopId: shop.id }, select: { currency: true } }))?.currency;
  const markets = await prisma.priceListRecord.findMany({
    where: { shopId: shop.id, surfaceKind: "MARKET", adjustmentBps: { not: 0 }, NOT: { currency: shopCurrency ?? "" } },
    select: { priceListGid: true, name: true, currency: true, contextCountry: true },
  });
  if (markets.length === 0) throw new Error(`${shop.domain} has no percentage market in another currency to preview`);
  console.log(`shop: ${shop.domain} (${shopCurrency}); markets: ${markets.map((m) => `${m.name} (${m.currency})`).join(", ")}`);

  // A handful of real variants no campaign has priced in these markets yet. A stored market
  // baseline answers in its place, which is why the bug only ever showed before a
  // variant's first apply -- and why a test on already-priced variants proves nothing.
  const priced = new Set(
    (
      await prisma.baseline.findMany({
        where: { shopId: shop.id, priceListGid: { in: markets.map((m) => m.priceListGid) } },
        select: { variantGid: true },
      })
    ).map((row) => row.variantGid),
  );
  const candidates = await prisma.variantIndex.findMany({
    where: { shopId: shop.id, deletedAt: null, status: "ACTIVE", isGiftCard: false, price: { gt: 0 } },
    select: { variantGid: true },
    take: 500,
  });
  const variantGids = candidates.map((row) => row.variantGid).filter((gid) => !priced.has(gid)).slice(0, 3);
  if (variantGids.length === 0) throw new Error("every sampled variant already has a market baseline");
  const campaign = await createCampaign(shop.id, {
    name: `Preview markets test ${Date.now()}`,
    priority: 960,
    rule: { kind: "percent-change", percent: -15 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "variantGid", value: variantGids }] }] },
    schedule: { kind: "manual" },
  });

  try {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { surfaces: { base: true, priceLists: markets.map((m) => m.priceListGid) } as never },
    });
    check(
      "no market baseline is stored for these variants yet",
      await prisma.baseline.count({ where: { shopId: shop.id, variantGid: { in: variantGids }, priceListGid: { not: "" } } }),
      0,
    );

    const preview = await previewCampaign(shop.id, campaign.id, { client });
    console.log(`   previewed ${preview.rows.length} variant(s)`);
    check("the preview planned every variant", preview.rows.length, variantGids.length);
    for (const market of markets) {
      const shown = preview.markets.find((m) => m.priceListGid === market.priceListGid);
      console.log(`   ${market.name}: ${shown?.refused ? "REFUSED — " : ""}${(shown?.explanation ?? "(missing)").slice(0, 140)}`);
      if (shown?.refused) {
        const quoted = await shopifyQuotes(client, variantGids[0], market.contextCountry);
        console.log(`      Shopify itself quotes ${market.contextCountry} in ${quoted}`);
        check(`${market.name} is refused only because Shopify quotes it in another currency`, quoted !== market.currency, true);
        continue;
      }
      const priced = preview.rows.filter((row) => row.surfaces?.[market.priceListGid]?.after).length;
      check(`${market.name} has a price for every variant`, priced, preview.rows.length);
      const first = preview.rows[0]?.surfaces?.[market.priceListGid]?.after;
      if (first) console.log(`      e.g. ${preview.rows[0].title}: ${first}`);
    }
  } finally {
    await prisma.campaign.delete({ where: { id: campaign.id } });
    console.log("\ncleaned up");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

async function shopifyQuotes(client: Client, variantGid: string, country: string | null): Promise<string | undefined> {
  if (!country) return undefined;
  const result = (await client.request(
    `query($id: ID!, $country: CountryCode!) {
       productVariant(id: $id) { contextualPricing(context: { country: $country }) { price { currencyCode } } }
     }`,
    { id: variantGid, country },
  )) as { data?: { productVariant?: { contextualPricing?: { price?: { currencyCode?: string } } } } };
  return result.data?.productVariant?.contextualPricing?.price?.currencyCode;
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
