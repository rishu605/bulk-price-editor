/**
 * ".99" means .990 of a dinar, not .099, in a market priced in a three-decimal currency
 * (#695).
 *
 * A charm ending was minor units below a major unit, so 99 was .99 of a dollar and .099 of
 * a Kuwaiti dinar: a USD store rounding to .99 that added a Kuwait market priced
 * KWD 12.500 at 12.099, a 3.2% cut under a label promising a cosmetic ending.
 *
 * Through the real preview and run, on a campaign whose store-wide rounding is .99.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";
import { redefine } from "../harness/definition";

const KWD = "gid://shopify/PriceList/kwd-charm";

describe("chaos: .99 rounding in a Kuwaiti dinar market", () => {
  it("ends every dinar price at .990, in the preview and on the storefront", async () => {
    await withChaos("charm-three-decimals", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: KWD,
        name: "Kuwait",
        currency: "KWD",
        country: "KW",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
        catalog: { id: "gid://shopify/MarketCatalog/kwd-charm", title: "KW", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [KWD] } as never } });
      // The store's .99, inherited by the dinar market: the case the ticket describes.
      await redefine(campaignId, { rounding: { default: "charm99", byCurrency: {} } });

      const preview = await previewCampaign(shopId, campaignId, { client: chaosAdminClient(chaos.server.endpoint()) });
      const market = preview.markets.find((m) => m.priceListGid === KWD);
      expect(market?.refused, `the dinar market was refused: ${market?.explanation}`).toBe(false);
      const previewed = variantGids.map((gid) => preview.rows.find((r) => r.variantGid === gid)?.surfaces?.[KWD]?.after);
      for (const after of previewed) {
        expect(after, "no dinar price previewed").toBeTruthy();
        expect(after, "a .99 ending became .099 of a dinar").toMatch(/\.990$/);
      }

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, KWD), "the storefront's dinar price").toMatch(/\.990$/);
      }
      // And the store's own dollars still end .99.
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toMatch(/\.99$/);
    });
  });
});
