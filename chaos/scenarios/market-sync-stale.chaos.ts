/**
 * A market sync removes a fixed price Shopify no longer has (#732).
 *
 * `syncMarkets` only ever upserted the fixed prices it read. After our own revert deleted a
 * campaign's fixed prices, the next sync left the rows at the sale price: What's live kept
 * showing the market on sale, and a recapture took the sale price as the new baseline.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const JP = "gid://shopify/PriceList/jp-stale";

function japan(chaos: ChaosContext, adjustment: { type: string; value: number } | null, fixed: string[] = []) {
  chaos.fake.addPriceList({
    id: JP,
    name: "Japan",
    currency: "JPY",
    country: "JP",
    adjustment,
    catalog: { id: "gid://shopify/MarketCatalog/jp-stale", title: "JP", __typename: "MarketCatalog" },
    prices: fixed.map((variantGid) => ({ variantGid, amount: "3000", compareAt: null, originType: "FIXED" as const })),
  });
}

async function sync(chaos: ChaosContext) {
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  return syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
}

const mirrored = async (shopId: string) =>
  (await prisma.priceSurfaceEntry.findMany({ where: { shopId, priceListGid: JP }, select: { variantGid: true } }))
    .map((row) => row.variantGid)
    .sort();

describe("chaos: a fixed market price Shopify no longer has", () => {
  it("is gone from the mirror after a campaign that wrote it is reverted and the markets sync again", async () => {
    await withChaos("market-sync-stale-revert", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      japan(chaos, { type: "PERCENTAGE_INCREASE", value: 20 });
      await sync(chaos);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { base: true, priceLists: [JP] } as never },
      });

      await chaos.apply();
      expect(chaos.fake.fixedPricesOn(JP).size, "the campaign wrote no fixed prices to Japan").toBeGreaterThan(0);
      await sync(chaos);
      expect((await mirrored(shopId)).length, "the sync did not mirror the campaign's fixed prices").toBeGreaterThan(0);

      await chaos.revert();
      expect(chaos.fake.fixedPricesOn(JP).size, "the revert left fixed prices in Shopify").toBe(0);
      await sync(chaos);
      expect(await mirrored(shopId), "the mirror kept fixed prices Shopify no longer has").toEqual([]);
    });
  });

  it("removes only the prices that went, and nothing when the read stops short", async () => {
    await withChaos("market-sync-stale-partial", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      japan(chaos, null, variantGids);
      await sync(chaos);
      expect(await mirrored(shopId)).toEqual([...variantGids].sort());

      // Shopify drops one fixed price, as our revert does.
      const list = chaos.fake.priceLists.find((l) => l.id === JP)!;
      list.prices = list.prices.filter((entry) => entry.variantGid !== variantGids[0]);
      await sync(chaos);
      expect(await mirrored(shopId)).toEqual(variantGids.slice(1).sort());

      // A read that stops short removes nothing: absence from an unfinished read is not
      // evidence the price is gone. Once with an answer that has no price list in it...
      list.prices = [];
      const handler = chaos.fake as unknown as { priceListPrices: (variables: unknown) => unknown };
      const once = vi.spyOn(handler, "priceListPrices").mockReturnValueOnce({ data: { priceList: null } });
      await sync(chaos);
      once.mockRestore();
      expect(await mirrored(shopId), "an answer with no prices in it emptied the mirror").toEqual(variantGids.slice(1).sort());

      // ...and once with a request that fails.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("prices(") }]);
      const failed = await sync(chaos);
      chaos.heal();
      expect(failed.errors.length).toBeGreaterThan(0);
      expect(await mirrored(shopId)).toEqual(variantGids.slice(1).sort());
    });
  });
});
