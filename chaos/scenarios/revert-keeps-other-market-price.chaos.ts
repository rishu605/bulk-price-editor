/**
 * Reverting a sale leaves another campaign's market price on a variant it still prices
 * (#1038).
 *
 * A whole revert deleted every fixed price it had written on a list that was not hand-set,
 * so a variant another campaign still priced there fell back to the list's percentage --
 * not resolve(without C) (rule 6), which is that campaign's price. "Revert this variant"
 * has written the other campaign's price since #1002; the whole revert now does the same.
 *
 * Through the real apply and revert of two campaigns on one market.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/revert-keeps-eu";

describe("chaos: reverting the higher of two sales on a market", () => {
  it("writes the lower sale's market price back rather than deleting it", async () => {
    await withChaos("revert-keeps-other-market-price", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: lower, variantGids } = chaos.fixture;
      const [shared] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
        catalog: { id: "gid://shopify/MarketCatalog/revert-keeps-eu", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(client, shopId);
      await prisma.campaign.update({
        where: { id: lower },
        data: { priority: 100, surfaces: { base: true, priceLists: [EUR] } as never },
      });

      // A, 10% off at priority 100, on the base price and Europe.
      await chaos.expectHonest((await chaos.apply()).runId);
      const lowersEuro = chaos.fake.fixedPricesOn(EUR).get(shared)?.amount;
      expect(lowersEuro, "the premise: A wrote a euro price").toBeTruthy();

      // B, 30% off at priority 200, over the shared variant, on the same market.
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: shared }, data: { tags: ["chaos", "chaos-b"] } });
      const higher = await createCampaign(shopId, {
        name: "chaos/higher-market-sale",
        priority: 200,
        rule: { kind: "percent-change", percent: -30 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos-b" }] }] },
        schedule: { kind: "manual" },
      } as never);
      await prisma.campaign.update({ where: { id: higher.id }, data: { surfaces: { base: true, priceLists: [EUR] } as never } });
      await chaos.expectHonest((await runCampaign(shopId, higher.id, client, { actor: "chaos", verifySampleRate: 1 })).runId);
      expect(chaos.fake.fixedPricesOn(EUR).get(shared)?.amount, "the premise: B took the euro price over").not.toBe(lowersEuro);

      // B ends: the shared variant goes back to A's euro price, not the list's own.
      const reverted = await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
      expect(reverted.clean).toBe(true);
      expect(chaos.fake.fixedPricesOn(EUR).get(shared)?.amount, "the revert left the list's price, not A's").toBe(lowersEuro);
    });
  });

  it("is taken back by the lower sale's own revert when the higher one handed it over (#1043)", async () => {
    await withChaos("market-handover-revert", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: lower, variantGids } = chaos.fixture;
      const [shared] = variantGids;
      const client = chaosAdminClient(chaos.server.endpoint());
      const HANDED = "gid://shopify/PriceList/market-handover-eu";
      chaos.fake.addPriceList({
        id: HANDED,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
        catalog: { id: "gid://shopify/MarketCatalog/market-handover-eu", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(client, shopId);
      await prisma.campaign.update({ where: { id: lower }, data: { priority: 100, surfaces: { base: true, priceLists: [HANDED] } as never } });

      // B first, so A's own apply never writes the shared variant's euro price.
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: shared }, data: { tags: ["chaos", "chaos-b"] } });
      const higher = await createCampaign(shopId, {
        name: "chaos/higher-market-sale",
        priority: 200,
        rule: { kind: "percent-change", percent: -30 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos-b" }] }] },
        schedule: { kind: "manual" },
      } as never);
      await prisma.campaign.update({ where: { id: higher.id }, data: { surfaces: { base: true, priceLists: [HANDED] } as never } });
      expect((await runCampaign(shopId, higher.id, client, { actor: "chaos", verifySampleRate: 1 })).clean).toBe(true);
      await chaos.expectHonest((await chaos.apply()).runId);
      const ofLower = await prisma.variantChange.count({ where: { shopId, variantGid: shared, surfaceKind: "MARKET", run: { campaignId: lower } } });
      expect(ofLower, "the premise: A never wrote the shared euro price").toBe(0);

      // B ends and hands the euro price to A.
      expect((await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 })).clean).toBe(true);
      expect(chaos.fake.fixedPricesOn(HANDED).get(shared), "the premise: B's revert wrote A's euro price").toBeTruthy();

      // A ends: nothing of A's is left on the market.
      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      expect(reverted.clean).toBe(true);
      expect(chaos.fake.fixedPricesOn(HANDED).get(shared), "A's euro price stayed after A ended").toBeUndefined();
      // Ledgered under A's revert before it was let go, and read back (I4, rule 5).
      const row = await prisma.variantChange.findFirst({ where: { runId: reverted.runId, variantGid: shared, priceListGid: HANDED } });
      expect(row?.status, "the release was not ledgered under A's revert").toBe("VERIFIED");
      expect(row?.intendedPrice).toBeNull();
      expect(chaos.fake.fixedPricesOn(HANDED).size).toBe(0);
    });
  });
});
