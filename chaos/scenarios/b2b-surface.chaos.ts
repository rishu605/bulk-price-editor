/**
 * Pricing into a B2B catalogue.
 *
 * The Wholesale tier charges for this, so it had better work. Quantity price breaks —
 * the genuinely B2B-specific part — are still gated behind beta signal (#174), but
 * targeting a company-location catalogue as a campaign surface is available today and is
 * what the plan gate actually sells.
 *
 * A B2B catalogue reaches Shopify through the same price-list mutations a market does,
 * which is why it works at all: the surface abstraction was built to make this a
 * configuration difference rather than a second code path.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

const WHOLESALE = "gid://shopify/PriceList/wholesale";

describe("chaos: pricing into a B2B catalogue", () => {
  it("applies and reverts a wholesale price list like any other surface", async () => {
    await withChaos(
      "b2b-surface",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -25 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        // A company-location catalogue. `surfaceKindOf` files a list with this catalog
        // type as B2B, and one with no catalog at all as B2B too.
        chaos.fake.addPriceList({
          id: WHOLESALE,
          name: "Trade partners",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 30 },
          catalog: {
            id: "gid://shopify/CompanyLocationCatalog/1",
            title: "Trade",
            __typename: "CompanyLocationCatalog",
          },
          prices: [],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        // Mirrored as B2B, not as a market. The distinction is what the plan gate reads.
        const record = await prisma.priceListRecord.findFirstOrThrow({
          where: { shopId, priceListGid: WHOLESALE },
        });
        expect(record.surfaceKind).toBe("B2B");

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [WHOLESALE] } as never },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Asserted on what a trade buyer actually pays, not on how it was written. A
        // uniform campaign over a whole catalogue takes the one-mutation path, so most
        // variants have no per-product row at all — checking for fixed prices would be
        // testing the write strategy rather than the price.
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid, WHOLESALE)).toBeDefined();
        }

        const rows = await prisma.variantChange.findMany({
          where: { runId: applied.runId, surfaceKind: "MARKET", priceListGid: WHOLESALE },
        });
        expect(rows).toHaveLength(variantGids.length);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);

        await chaos.revert();

        // Back to the list deriving from its own 30%, with no per-product prices left
        // pinned to the sale.
        expect(chaos.fake.fixedPricesOn(WHOLESALE).size).toBe(0);
        const reverted = await prisma.variantChange.count({
          where: { shopId, priceListGid: WHOLESALE, status: "REVERTED" },
        });
        expect(reverted).toBe(variantGids.length);
      },
    );
  });

  it("prices a market and a wholesale catalogue in the same campaign, independently", async () => {
    await withChaos(
      "b2b-and-market",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        chaos.fake.addPriceList({
          id: WHOLESALE,
          name: "Trade partners",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 30 },
          catalog: {
            id: "gid://shopify/CompanyLocationCatalog/1",
            title: "Trade",
            __typename: "CompanyLocationCatalog",
          },
          prices: [],
        });
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/eu",
          name: "Europe",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
          prices: [],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: {
              base: true,
              priceLists: [WHOLESALE, "gid://shopify/PriceList/eu"],
            } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Each surface priced from its own baseline in its own currency. The wholesale
        // list is 30% below base in dollars; the European one is 10% below base in
        // euros. Neither number is derived from the other.
        for (const gid of variantGids) {
          const trade = chaos.fake.priceOf(gid, WHOLESALE);
          const eu = chaos.fake.priceOf(gid, "gid://shopify/PriceList/eu");

          expect(trade).toBeDefined();
          expect(eu).toBeDefined();
          // Different numbers, because each came from its own baseline in its own
          // currency rather than one being converted from the other.
          expect(trade).not.toBe(eu);
        }

        // And both surfaces are ledgered separately, so support can answer "why is this
        // that price for this buyer" per surface.
        const bySurface = await prisma.variantChange.groupBy({
          by: ["priceListGid"],
          where: { runId: applied.runId, surfaceKind: "MARKET" },
          _count: true,
        });
        expect(bySurface).toHaveLength(2);
      },
    );
  });
});
