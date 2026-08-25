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
});
