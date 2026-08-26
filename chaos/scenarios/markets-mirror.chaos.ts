/**
 * Mirroring markets and B2B price lists.
 *
 * The failure that matters here is one of scale rather than of correctness. Most market
 * price lists do not store prices — they hold a percentage against the base list and
 * Shopify derives the rest — and a mirror that expanded those per variant would turn one
 * number into two million rows on a 500K-variant catalogue across four markets. Every
 * one of them restating the same percentage, and every one of them needing to stay in
 * step with it.
 *
 * So the scenario asserts what is *absent* as carefully as what is present: a relative
 * list contributes its rule and not a single mirrored row, even though Shopify returns
 * a price per variant when asked.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: mirroring market and B2B price lists", () => {
  it("stores a relative list as its rule and a fixed list as rows", async () => {
    await withChaos(
      "markets-mirror",
      { catalog: { products: 4, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        // A market list that derives everything from a 5% decrease. Shopify answers
        // with a price per variant regardless, all marked RELATIVE.
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/relative",
          name: "Canada",
          currency: "CAD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 5 },
          catalog: { id: "gid://shopify/MarketCatalog/1", title: "Canada", __typename: "MarketCatalog" },
          prices: variantGids.map((gid) => ({
            variantGid: gid,
            amount: "1.00",
            compareAt: null,
            originType: "RELATIVE" as const,
          })),
        });

        // A B2B list that genuinely stores prices. No catalog, which is how a
        // company-location list presents.
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/fixed",
          name: "Wholesale",
          currency: "USD",
          adjustment: null,
          catalog: null,
          prices: [
            { variantGid: variantGids[0], amount: "12.34", compareAt: "20.00", originType: "FIXED" },
            { variantGid: variantGids[1], amount: "56.78", compareAt: null, originType: "FIXED" },
            // Mixed in, as the real API does. Storing it would make the mirror
            // disagree with itself about whether the list is derived.
            { variantGid: variantGids[2], amount: "99.99", compareAt: null, originType: "RELATIVE" },
          ],
        });

        const result = await syncMarkets(client, shopId);

        expect(result.priceLists).toBe(2);
        expect(result.relative).toBe(1);
        expect(result.fixed).toBe(1);
        // Two fixed entries. Not three, and emphatically not eight plus three.
        expect(result.entries).toBe(2);
        expect(result.errors).toEqual([]);

        // ------------------------------------------------- the rule, not the rows
        const relative = await prisma.priceListRecord.findFirstOrThrow({
          where: { shopId, priceListGid: "gid://shopify/PriceList/relative" },
        });
        expect(relative.adjustmentBps).toBe(-500);
        expect(relative.surfaceKind).toBe("MARKET");
        expect(relative.currency).toBe("CAD");

        const expandedAnyway = await prisma.priceSurfaceEntry.count({
          where: { shopId, priceListGid: "gid://shopify/PriceList/relative" },
        });
        expect(expandedAnyway).toBe(0);

        // ------------------------------------------------------ the fixed rows
        const fixed = await prisma.priceListRecord.findFirstOrThrow({
          where: { shopId, priceListGid: "gid://shopify/PriceList/fixed" },
        });
        expect(fixed.adjustmentBps).toBeNull();
        // No catalog means a company-location list, which is B2B rather than a market.
        expect(fixed.surfaceKind).toBe("B2B");

        const rows = await prisma.priceSurfaceEntry.findMany({
          where: { shopId, priceListGid: "gid://shopify/PriceList/fixed" },
          orderBy: { variantGid: "asc" },
        });
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => Number(r.livePrice)).sort((a, b) => a - b)).toEqual([1_234, 5_678]);
        // Compare-at is mirrored per surface where it exists, and left null where not.
        expect(rows.filter((r) => r.liveCompareAt !== null)).toHaveLength(1);

        // ----------------------------------------- base rows are still uniform
        // The temptation is to read base prices from variant_index and reserve this
        // table for markets. One shape for "the live value on surface X" is what lets
        // everything downstream read all three surfaces without branching.
        const base = await prisma.priceSurfaceEntry.count({
          where: { shopId, surfaceKind: "BASE", priceListGid: "" },
        });
        expect(base).toBe(variantGids.length);
      },
    );
  });

  it("forgets a list the merchant deleted, and its mirrored rows with it", async () => {
    await withChaos(
      "markets-deleted",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/doomed",
          name: "Temporary",
          currency: "USD",
          adjustment: null,
          catalog: null,
          prices: [
            { variantGid: variantGids[0], amount: "5.00", compareAt: null, originType: "FIXED" },
          ],
        });

        await syncMarkets(client, shopId);
        expect(
          await prisma.priceSurfaceEntry.count({
            where: { shopId, priceListGid: "gid://shopify/PriceList/doomed" },
          }),
        ).toBe(1);

        // Deleted in Shopify. Its mirrored rows must go too, or a campaign keeps
        // resolving against a surface that no longer exists.
        chaos.fake.priceLists.length = 0;
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/survivor",
          name: "Kept",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/2", title: "EU", __typename: "MarketCatalog" },
          prices: [],
        });

        await syncMarkets(client, shopId);

        expect(
          await prisma.priceListRecord.count({
            where: { shopId, priceListGid: "gid://shopify/PriceList/doomed" },
          }),
        ).toBe(0);
        expect(
          await prisma.priceSurfaceEntry.count({
            where: { shopId, priceListGid: "gid://shopify/PriceList/doomed" },
          }),
        ).toBe(0);
      },
    );
  });

  it("mirrors a hand-set override on a list that also has a rule", async () => {
    /**
     * A list can be both, and this scenario is the case the file's opening argument
     * misses. Shopify lets a fixed price shadow the parent adjustment for one variant —
     * how a merchant says "10% off Japan, except this one product at ¥1,200" — and the
     * sync used to skip straight past those the moment a list had an adjustment.
     *
     * What made it costly is that the two reads which could have caught it both look the
     * other way. `readDerivedPrices` asks `originType: RELATIVE`, so an overridden variant
     * does not come back at all; the campaign concluded it was not priced on that market
     * and left it alone. A merchant's "20% off in Japan" then skipped exactly the products
     * they had cared enough about to price by hand.
     *
     * The absence assertion this file was built on still holds — the rule is not expanded
     * — so both are asserted together, because the fix is only correct if it adds the
     * overrides *without* expanding the rule.
     */
    await withChaos(
      "markets-mirror-override",
      { catalog: { products: 4, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());

        const overridden = variantGids[0];

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/jp",
          name: "Japan",
          currency: "JPY",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/jp", title: "Japan", __typename: "MarketCatalog" },
          prices: variantGids.map((gid) => ({
            variantGid: gid,
            // Whole yen, because JPY has no decimal places — a compare-at of 1800 against
            // a price of 1200 is the per-market strike-through the product exists for.
            amount: gid === overridden ? "1200" : "1.00",
            compareAt: gid === overridden ? "1800" : null,
            originType: gid === overridden ? ("FIXED" as const) : ("RELATIVE" as const),
          })),
        });

        const result = await syncMarkets(client, shopId);
        expect(result.errors).toEqual([]);

        const mirrored = await prisma.priceSurfaceEntry.findMany({
          where: { shopId, priceListGid: "gid://shopify/PriceList/jp" },
        });

        // Exactly the hand-set one. Not zero, which is what the bug produced, and not one
        // per variant, which is what expanding the rule would produce.
        expect(mirrored).toHaveLength(1);
        expect(mirrored[0].variantGid).toBe(overridden);
        expect(mirrored[0].livePrice).toBe(1_200n);
        expect(mirrored[0].liveCompareAt).toBe(1_800n);
        expect(mirrored[0].currency).toBe("JPY");

        // And the rule is still stored as a rule.
        const list = await prisma.priceListRecord.findFirstOrThrow({
          where: { shopId, priceListGid: "gid://shopify/PriceList/jp" },
        });
        expect(list.adjustmentBps).toBe(-1_000);
      },
    );
  });
});