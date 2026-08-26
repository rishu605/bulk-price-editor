/**
 * A strike-through sale across three currencies, applied and reverted.
 *
 * This is the ticket's headline criterion and the product's commercial wedge: per-market
 * `compareAtPrice`, which the ecosystem broadly believes Shopify does not support. It
 * does — on the variant-level mutation. The product-level one is the obvious choice and
 * its input has no compare-at field at all, which is almost certainly where the belief
 * comes from.
 *
 * Two properties are asserted that a naive implementation would get wrong:
 *
 *   Each market's price is its own rule applied to its own baseline, not the base
 *   surface's answer converted. A campaign that converted would make the EUR discount a
 *   function of USD rounding, and would have nothing sensible to do with a set-exact or
 *   cost-margin rule at all.
 *
 *   Revert *deletes* the fixed prices rather than writing the old ones back, so a
 *   relative list goes back to tracking its percentage. Writing numbers back would pin
 *   prices the merchant never chose and quietly stop the market following the base price.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { formatMoney, money, parseMoney } from "../../app/lib/money/money";
import { withChaos, type ChaosContext } from "../harness/scenario";

/**
 * The market baseline the fake derives, as a number of that market's minor units.
 *
 * Read out of the fake rather than recomputed here. An expectation that reimplements
 * the conversion agrees with itself no matter what the engine did; asking the store
 * what the shopper would otherwise have paid is the only version of this assertion
 * that can actually fail.
 */
function derivedBaseline(chaos: ChaosContext, gid: string, priceListGid: string): number {
  const list = chaos.fake.priceLists.find((l) => l.id === priceListGid)!;
  return parseMoney(chaos.fake.derivedPriceOf(gid, list)!, list.currency).amount;
}

/** The same value formatted the way that market's price list reports it. */
function at(chaos: ChaosContext, amount: number, priceListGid: string): string {
  const list = chaos.fake.priceLists.find((l) => l.id === priceListGid)!;
  return formatMoney(money(amount, list.currency));
}

describe("chaos: writing campaign prices to markets", () => {
  it("applies a strike-through sale in USD, EUR and JPY, then removes it", async () => {
    await withChaos(
      "market-write",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        // Three markets: one fixed-price list and two that derive from a percentage.
        // A campaign has to work on both kinds, and the reference price it computes
        // from is different for each.
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/eu",
          name: "Europe",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
          prices: [],
        });
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/jp",
          name: "Japan",
          currency: "JPY",
          adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
          catalog: { id: "gid://shopify/MarketCatalog/jp", title: "JP", __typename: "MarketCatalog" },
          prices: [],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        // Target both markets alongside the base surface, and set the compare-at policy
        // so the campaign produces a strike-through at all.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: {
              base: true,
              priceLists: ["gid://shopify/PriceList/eu", "gid://shopify/PriceList/jp"],
            } as never,
            compareAtPolicy: { kind: "set-to-baseline" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // ------------------------------------------------------------- EUR
        // Baseline on this market is the base baseline less 10%, and the campaign takes
        // 20% off *that* — not off the USD sale price.
        const eu = chaos.fake.fixedPricesOn("gid://shopify/PriceList/eu");
        expect(eu.size).toBe(variantGids.length);

        for (const gid of variantGids) {
          const euBaseline = derivedBaseline(chaos, gid, "gid://shopify/PriceList/eu");
          const row = eu.get(gid)!;
          expect(row.amount).toBe(at(chaos, Math.round(euBaseline * 0.8), "gid://shopify/PriceList/eu"));
          // The strike-through is this market's own number, so a shopper in the EU sees
          // what they would otherwise have paid there — in euros, at the euro price.
          expect(row.compareAt).toBe(at(chaos, euBaseline, "gid://shopify/PriceList/eu"));
        }

        // ------------------------------------------------------------- JPY
        //
        // The trap. Yen has no decimal places and the rate is ~148, so a campaign that
        // reinterpreted the base surface's minor units as the market's would write ¥93
        // where the shopper expects ¥9,188 — a 99% discount, live, in a market the
        // merchant probably cannot read. An increase rather than a decrease, so the
        // direction of the adjustment is exercised too.
        const jp = chaos.fake.fixedPricesOn("gid://shopify/PriceList/jp");
        for (const gid of variantGids) {
          const jpBaseline = derivedBaseline(chaos, gid, "gid://shopify/PriceList/jp");
          const price = jp.get(gid)!;

          expect(price.amount).toBe(at(chaos, Math.round(jpBaseline * 0.8), "gid://shopify/PriceList/jp"));
          // Whole yen, with no decimal point anywhere in the string.
          expect(price.amount).toMatch(/^\d+$/);
          // And in the right order of magnitude for the market, which is the assertion
          // that actually catches the conversion being skipped.
          expect(jpBaseline).toBeGreaterThan(1000);
        }

        // ------------------------------------------------- ledgered per surface
        const marketRows = await prisma.variantChange.findMany({
          where: { runId: applied.runId, surfaceKind: "MARKET" },
        });
        expect(marketRows).toHaveLength(variantGids.length * 2);
        expect(marketRows.every((row) => row.status === "VERIFIED")).toBe(true);
        expect(marketRows.every((row) => row.intendedCompareAtSet)).toBe(true);
        // Each row names the surface it was written to, so support can answer "why is
        // this variant that price in Japan".
        expect(new Set(marketRows.map((r) => r.priceListGid)).size).toBe(2);

        // ------------------------------------------------------------ revert
        await chaos.revert();

        // Deleted, not rewritten. Both lists go back to deriving from their percentage.
        expect(chaos.fake.fixedPricesOn("gid://shopify/PriceList/eu").size).toBe(0);
        expect(chaos.fake.fixedPricesOn("gid://shopify/PriceList/jp").size).toBe(0);

        const reverted = await prisma.variantChange.findMany({
          where: { shopId, surfaceKind: "MARKET", status: "REVERTED" },
        });
        expect(reverted).toHaveLength(variantGids.length * 2);
      },
    );
  });

  it("chunks at 250 prices per request, because Shopify rejects more", async () => {
    await withChaos(
      "market-write-chunked",
      { catalog: { products: 300, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        expect(variantGids.length).toBe(300);

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/big",
          name: "Big market",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 5 },
          catalog: { id: "gid://shopify/MarketCatalog/big", title: "Big", __typename: "MarketCatalog" },
          prices: [],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: ["gid://shopify/PriceList/big"] } as never },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // All 300 landed, which they could not have in one request — the fake rejects
        // anything over the cap exactly as Shopify does, so a chunking bug fails here
        // rather than at the first real store.
        expect(chaos.fake.fixedPricesOn("gid://shopify/PriceList/big").size).toBe(300);
      },
    );
  });

  it("prices a variant the merchant had hand-set on an adjusted market", async () => {
    /**
     * The case where a market list carries a rule *and* a hand-set price for one variant.
     * Shopify allows it — a fixed price shadows the parent adjustment — and it is how a
     * merchant says "10% off Japan, except this one product at ¥1,200".
     *
     * The campaign used to skip that variant entirely. Baselines for an adjusted list came
     * only from `readDerivedPrices`, which asks `originType: RELATIVE`; an overridden
     * variant has origin FIXED, so Shopify returned nothing for it and the planner
     * concluded it was not priced on that market at all. A merchant's "20% off in Japan"
     * therefore skipped precisely the products they had cared enough to price by hand —
     * and the run reported them as unpriced there rather than as missed.
     *
     * Asserted as "was it priced, and from the right baseline", because pricing it from
     * the *derived* number would be worse than skipping it: that is a discount off a
     * price the merchant had explicitly overridden.
     */
    await withChaos(
      "market-override-priced",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const overridden = variantGids[0];

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/jp",
          name: "Japan",
          currency: "JPY",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/jp", title: "JP", __typename: "MarketCatalog" },
          prices: [
            {
              variantGid: overridden,
              // Whole yen: JPY has no decimal places.
              amount: "1200",
              compareAt: null,
              originType: "FIXED" as const,
            },
          ],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: ["gid://shopify/PriceList/jp"] } as never },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // The baseline is the merchant's own ¥1,200, not whatever the rule would have
        // derived. This is the assertion that matters: a baseline taken from the rule
        // would discount a price the merchant had deliberately overridden.
        const baseline = await prisma.baseline.findFirstOrThrow({
          where: {
            shopId,
            variantGid: overridden,
            surfaceKind: "MARKET",
            priceListGid: "gid://shopify/PriceList/jp",
            supersededAt: null,
          },
        });
        expect(baseline.basePrice).toBe(1_200n);
        expect(baseline.currency).toBe("JPY");

        // And it was actually repriced rather than quietly passed over — 20% off ¥1,200.
        const jp = chaos.fake.fixedPricesOn("gid://shopify/PriceList/jp");
        expect(jp.has(overridden), "the hand-set variant was skipped").toBe(true);
        expect(jp.get(overridden)!.amount).toBe("960");

        // The variants the rule still governs were priced too, so preferring overrides
        // did not cost the ordinary path.
        expect(jp.size).toBe(variantGids.length);
      },
    );
  });
});