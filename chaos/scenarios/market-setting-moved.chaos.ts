/**
 * A sale on a percentage market computes from that market's percentage as it is now, not as
 * it was the first time a campaign priced it (#1093).
 *
 * The market's baseline was read once and never again. A merchant who moved EU from 10% to
 * 30% off between two sales had the second computed from the 10%-off price: 20% off it was
 * 64.26 against a new regular price of 62.47 -- a "sale" about 3% above the regular price,
 * verified clean, with nothing said.
 *
 * Through the real apply, revert, markets sync and preview, against a list the fake derives.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, withChaos } from "../harness/scenario";

const EU = "gid://shopify/PriceList/setting-moved-eu";
const cents = (amount: string) => Math.round(Number(amount) * 100);

async function onEurope(chaos: ChaosContext, percentOff: number) {
  const { shopId, campaignId } = chaos.fixture;
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: { type: "PERCENTAGE_DECREASE", value: percentOff },
    catalog: { id: "gid://shopify/MarketCatalog/setting-moved-eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
  await syncMarkets(chaos);
  await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [EU] } as never } });
  void shopId;
}

async function syncMarkets(chaos: ChaosContext) {
  const { syncMarkets: sync } = await import("../../app/services/markets-sync.server");
  await sync(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
}

/** The merchant moves the list's percentage in Shopify; the markets sync records it. */
async function merchantSets(chaos: ChaosContext, percentOff: number) {
  chaos.fake.priceLists.find((list) => list.id === EU)!.adjustment = { type: "PERCENTAGE_DECREASE", value: percentOff };
  await syncMarkets(chaos);
}

describe("chaos: a percentage market whose setting moved between sales", () => {
  it("prices the next sale from the market's new regular price, never above it", async () => {
    await withChaos("market-setting-moved", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await onEurope(chaos, 10);

      await chaos.expectHonest((await chaos.apply()).runId);
      await chaos.expectHonest((await chaos.revert()).runId);

      // EU moves from 10% to 30% off, with no campaign on it.
      await merchantSets(chaos, 30);
      const regular = new Map(variantGids.map((gid) => [gid, cents(chaos.fake.priceOf(gid, EU)!)]));

      const again = await chaos.apply();
      await chaos.expectHonest(again.runId);
      for (const gid of variantGids) {
        const sale = cents(chaos.fake.priceOf(gid, EU)!);
        expect(sale, `${gid}: the sale is above the market's regular price`).toBeLessThan(regular.get(gid)!);
        // 20% off the market's price now, to the cent the rounding allows.
        expect(Math.abs(sale - Math.round(regular.get(gid)! * 0.8)), `${gid}: not 20% off the new regular price`).toBeLessThanOrEqual(1);
      }

      // The baseline now records the setting it was read at.
      const baselines = await prisma.baseline.findMany({ where: { shopId, priceListGid: EU, surfaceKind: "MARKET", supersededAt: null } });
      expect(baselines).toHaveLength(variantGids.length);
      for (const row of baselines) {
        expect(Number(row.basePrice)).toBe(regular.get(row.variantGid));
        expect(row.listAdjustmentBps, "the setting it was read at").not.toBeNull();
      }
    });
  });

  it("leaves a variant out and says why when the setting moves while the sale is on", async () => {
    await withChaos("market-setting-moved-live", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await onEurope(chaos, 10);
      await chaos.expectHonest((await chaos.apply()).runId);

      // Moved during the sale: the price on the variants is the sale's, so the market's new
      // regular price cannot be read until it ends.
      await merchantSets(chaos, 30);
      const preview = await previewCampaign(shopId, campaignId, { limit: 100, client: chaosAdminClient(chaos.server.endpoint()) });
      const europe = preview.markets.find((market) => market.name.includes("Europe"));
      expect(europe?.explanation, "the preview priced Europe from its old setting without a word").toMatch(
        /2 variants not priced separately\. This market's percentage has changed since their price here was recorded/,
      );
    });
  });
});
