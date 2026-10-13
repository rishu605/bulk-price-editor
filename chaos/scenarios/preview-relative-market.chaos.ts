/**
 * A new campaign's preview prices a percentage market as the run then does (#840).
 *
 * Before a campaign's first apply, its preview refused every market priced by a
 * percentage: "it answered in USD, so they are wrong by an exchange rate and this campaign
 * will not price that market". The preview loaded the market without its country, so it
 * read the list's own prices, which Shopify answers in the shop's currency. The run loaded
 * the whole row and priced the same market fine. Rule 4: preview and execution share one
 * code path, and here they were handed different inputs.
 *
 * Driven on a campaign that has never been applied, so no stored market baseline can
 * stand in for the read the preview has to make itself.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/eu-preview";

describe("chaos: previewing a percentage-priced market before the first apply", () => {
  it("prices the market, at the prices the run then writes", async () => {
    await withChaos("preview-relative-market", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/eu-preview", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { base: true, priceLists: [EUR] } as never },
      });
      expect(await prisma.baseline.count({ where: { shopId, priceListGid: EUR } }), "a stored baseline would hide the read").toBe(0);

      const preview = await previewCampaign(shopId, campaignId, { client: chaosAdminClient(chaos.server.endpoint()) });
      const market = preview.markets.find((m) => m.priceListGid === EUR);
      expect(market, "the preview lost the market").toBeDefined();
      expect(market!.refused, `the preview refused a market the run prices: ${market!.explanation}`).toBe(false);
      const previewed = new Map(variantGids.map((gid) => [gid, preview.rows.find((row) => row.variantGid === gid)?.surfaces?.[EUR]?.after]));
      for (const gid of variantGids) expect(previewed.get(gid), `no euro price previewed for ${gid}`).toMatch(/\d/);

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      for (const gid of variantGids) {
        expect(previewed.get(gid), "the preview and the run disagree on a euro price").toBe(chaos.fake.priceOf(gid, EUR));
      }
    });
  });
});
