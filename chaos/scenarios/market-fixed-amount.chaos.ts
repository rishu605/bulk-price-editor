/**
 * A fixed amount and a market in another currency (#692).
 *
 * "Set an exact price" and "Fixed change" are entered in the store's currency. With a
 * Japan market ticked, `set-exact` sent the dollar amount relabelled as yen -- ¥20 on a
 * product that sells for about ¥3,000 -- and read-back verified it clean. `fixed-change`,
 * and `set-exact` with the "show the normal price" strike-through, threw a currency
 * mismatch from inside the preview, so the campaign's own page could not be opened.
 *
 * The market is fixed-price here because the preview only reads a fixed list correctly
 * before the first apply (#840); the rule under test does not care which kind it is.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { money } from "../../app/lib/money/money";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const JPY = "gid://shopify/PriceList/jp-fixed-amount";

async function withJapanMarket(chaos: ChaosContext, rule: unknown, compareAtPolicy: unknown) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  chaos.fake.addPriceList({
    id: JPY,
    name: "Japan",
    currency: "JPY",
    country: "JP",
    adjustment: null,
    catalog: { id: "gid://shopify/MarketCatalog/jp-fixed-amount", title: "JP", __typename: "MarketCatalog" },
    prices: variantGids.map((variantGid) => ({
      variantGid,
      amount: "3000",
      compareAt: null,
      originType: "FIXED" as const,
    })),
  });

  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      surfaces: { base: true, priceLists: [JPY] } as never,
      ruleRows: [{ segmentIds: [], rule }] as never,
      compareAtPolicy: compareAtPolicy as never,
    },
  });
}

describe("chaos: a fixed amount against a market in another currency", () => {
  it("sets $20 on the base price and leaves the yen market alone, saying why", async () => {
    await withChaos(
      "market-fixed-amount-set-exact",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { variantGids } = chaos.fixture;
        await withJapanMarket(chaos, { kind: "set-exact", amount: money(2_000, "USD") }, { kind: "leave" });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe("20.00");

        // Nothing written to Japan: not ¥20, not a conversion of $20.
        const yen = await prisma.variantChange.findMany({
          where: { runId: applied.runId, priceListGid: JPY },
        });
        expect(yen, "the dollar amount reached the yen market").toHaveLength(0);
        expect(applied.messages.join("\n")).toMatch(
          new RegExp(`Japan: ${variantGids.length} variants left at full price: they are priced by a fixed amount in another currency`),
        );
      },
    );
  });

  it("opens the campaign's preview for a fixed change with the strike-through policy", async () => {
    await withChaos(
      "market-fixed-amount-preview",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await withJapanMarket(
          chaos,
          { kind: "fixed-change", amount: money(-500, "USD") },
          { kind: "set-to-baseline" },
        );

        // What the campaign page's loader calls. It threw CurrencyMismatchError, and the
        // page rendered "Something went wrong" with no way to archive the campaign.
        const preview = await previewCampaign(shopId, campaignId, {
          client: chaosAdminClient(chaos.server.endpoint()),
        });

        const japan = preview.markets.find((m) => m.priceListGid === JPY);
        expect(japan?.skipped).toBe(variantGids.length);
        expect(japan?.explanation).toMatch(/fixed amount in another currency/);
      },
    );
  });
});
