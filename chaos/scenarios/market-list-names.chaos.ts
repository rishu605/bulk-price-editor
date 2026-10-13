/**
 * The preview names a market the way the editor did (#778).
 *
 * Shopify names a market's price list after the market's handle. The campaign page printed
 * that -- `pricing_by_market.19853246698_1786915628` -- in the preview's column header, the
 * Markets card, the Apply dialog and the preview CSV, where the editor's checkbox had said
 * "United States (USD)". Everything those show comes from `previewCampaign`.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const LIST = "gid://shopify/PriceList/us-generated-name";

describe("chaos: a market whose price list has a generated name", () => {
  it("is called by its market's name in the preview, never by the handle Shopify gave the list", async () => {
    await withChaos("market-list-names", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      chaos.fake.addPriceList({
        id: LIST,
        name: "pricing_by_market.19853246698_1786915628",
        currency: "USD",
        country: "US",
        adjustment: null,
        catalog: { id: "gid://shopify/MarketCatalog/us-generated-name", title: "United States", __typename: "MarketCatalog" },
        prices: variantGids.map((variantGid) => ({ variantGid, amount: "40.00", compareAt: null, originType: "FIXED" as const })),
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(client, shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [LIST] } as never } });

      // With a client (the campaign page) and without one (a page that cannot ask Shopify).
      for (const preview of [await previewCampaign(shopId, campaignId, { client }), await previewCampaign(shopId, campaignId)]) {
        expect(preview.markets.map((market) => market.name)).toEqual(["United States"]);
        expect(JSON.stringify(preview), "the machine name reached the page").not.toContain("pricing_by_market");
      }
    });
  });
});
