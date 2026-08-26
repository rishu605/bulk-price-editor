/**
 * Rounding chosen per currency, applied per surface.
 *
 * Edge case E9. A shared profile is not a cosmetic compromise: `.99` is what a shopper
 * in dollars reads as a considered price, and a yen price cannot end in `.99` at all
 * because there is nothing below a yen. A campaign that priced every market the same
 * way would produce, in at least one market, prices that look like a broken import —
 * which defeats the entire reason to price per market.
 *
 * Asserted against the live store rather than against the planner, because the question
 * is what a shopper sees, not what we intended.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/eu";
const JP = "gid://shopify/PriceList/jp";

function addMarkets(chaos: ChaosContext) {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
  chaos.fake.addPriceList({
    id: JP,
    name: "Japan",
    currency: "JPY",
    country: "JP",
    adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
    catalog: { id: "gid://shopify/MarketCatalog/jp", title: "JP", __typename: "MarketCatalog" },
    prices: [],
  });
}

describe("chaos: rounding chosen per currency", () => {
  it("ends dollar and euro prices differently, and never invents a fraction of a yen", async () => {
    await withChaos(
      "rounding-per-currency",
      { catalog: { products: 12, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addMarkets(chaos);
        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [EU, JP] } as never,
            schedule: {
              ...(campaign.schedule as object),
              rounding: {
                default: "charm99",
                // Euro-zone charm, and yen left to the default — which must not inherit
                // a charm ending it has no room for.
                byCurrency: { EUR: "charm95" },
              },
            } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // The store's own currency: .99, as chosen.
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toMatch(/\.99$/);
        }

        // Europe: .95, because a euro price was configured differently. This is the
        // assertion that a single shared profile would fail.
        const eu = chaos.fake.fixedPricesOn(EU);
        expect(eu.size).toBe(variantGids.length);
        for (const [, price] of eu) {
          expect(price.amount).toMatch(/\.95$/);
        }

        // Japan: whole yen, and rounded to something tidy rather than left ragged.
        // A `.99` ending inherited here would have to become either a fractional yen —
        // which Shopify rejects — or a silent lie about what the campaign does.
        const jp = chaos.fake.fixedPricesOn(JP);
        expect(jp.size).toBe(variantGids.length);
        for (const [, price] of jp) {
          expect(price.amount).toMatch(/^\d+$/);
          expect(Number(price.amount) % 10).toBe(0);
        }
      },
    );
  });

  it("keeps an older campaign's bare rounding string doing exactly what it did", async () => {
    await withChaos(
      "rounding-legacy",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        // The shape campaigns stored before rounding was per-currency. Changing what an
        // existing campaign does to live prices is the one migration this product
        // cannot ship.
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            schedule: { ...(campaign.schedule as object), rounding: "charm99" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toMatch(/\.99$/);
        }
      },
    );
  });
});
