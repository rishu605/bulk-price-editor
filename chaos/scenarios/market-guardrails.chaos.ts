/**
 * Store guardrails on a market priced in its own currency (#691).
 *
 * Guardrails are entered once, in the store's currency; a market is priced in its own.
 * Turning one on used to take every market out of every campaign, silently:
 *
 *   A minimum price in dollars, compared with a euro price, threw a currency mismatch.
 *   The run caught it as "market prices did not finish" and priced no market at all.
 *
 *   A cost-based guardrail cannot be checked on a market, whose rows carry no cost, so
 *   every row was skipped -- and skipped rows were filtered out with no outcome and no
 *   message. The preview, which planned markets without the store's guardrails, showed
 *   the same markets priced.
 *
 * What a merchant sees is asserted -- the run's messages and the preview -- as well as
 * what the ledger holds for the market.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/eu-guardrails";

/**
 * A euro market the fixture campaign also prices.
 *
 * `fixed` gives every variant a hand-set euro price rather than a percentage. The
 * preview can only read a fixed list today: it plans markets without their country, so a
 * percentage list answers in the shop's currency and is refused (#840).
 */
async function withEuroMarket(chaos: ChaosContext, fixed = false) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  chaos.fake.addPriceList({
    id: EUR,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: fixed ? null : { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu-guardrails", title: "EU", __typename: "MarketCatalog" },
    prices: fixed
      ? variantGids.map((variantGid) => ({
          variantGid,
          amount: "50.00",
          compareAt: null,
          originType: "FIXED" as const,
        }))
      : [],
  });

  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [EUR] } as never },
  });
}

async function euroLedger(runId: string) {
  return prisma.variantChange.findMany({ where: { runId, priceListGid: EUR } });
}

describe("chaos: store guardrails on markets", () => {
  it("a minimum price in dollars no longer stops a euro market", async () => {
    await withChaos(
      "market-guardrail-min-price",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        await withEuroMarket(chaos);
        await writeSettings(chaos.fixture.shopId, { ...DEFAULT_SETTINGS, minPrice: 5 });

        const applied = await chaos.apply();

        expect(
          applied.messages.join("\n"),
          "the dollar floor was compared with a euro price",
        ).not.toMatch(/did not finish|Cannot combine/);
        const rows = await euroLedger(applied.runId);
        expect(rows).toHaveLength(chaos.fixture.variantGids.length);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);
      },
    );
  });

  it("a cost guardrail leaves the market at full price and says so, in the run and the preview", async () => {
    await withChaos(
      "market-guardrail-cost",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await withEuroMarket(chaos, true);

        // Costs recorded in the store's currency, low enough that the base price passes.
        await prisma.variantIndex.updateMany({ where: { shopId }, data: { cost: 100n } });
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, neverBelowCost: true });

        // ------------------------------------------------------------ preview
        const preview = await previewCampaign(shopId, campaignId, {
          client: chaosAdminClient(chaos.server.endpoint()),
        });
        const market = preview.markets.find((m) => m.priceListGid === EUR);
        expect(market, "the preview lost the market").toBeDefined();
        expect(market!.skipped, "the preview priced a market the run will skip").toBe(
          variantGids.length,
        );
        expect(market!.explanation).toMatch(/left at full price.*cannot be checked in EUR/);

        // ---------------------------------------------------------------- run
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // The base surface is priced: its costs are known and the sale is above them.
        expect(applied.verified).toBe(variantGids.length);

        // The market is not, and the merchant is told which market and why.
        expect(await euroLedger(applied.runId)).toHaveLength(0);
        const said = applied.messages.join("\n");
        expect(said, "the market was skipped in silence").toMatch(
          new RegExp(`Europe: ${variantGids.length} variants left at full price`),
        );
        expect(said).toMatch(/cannot be checked in EUR/);
      },
    );
  });

  it("checks a market in the store's own currency against the recorded cost, and prices it", async () => {
    await withChaos(
      "market-guardrail-same-currency",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const US = "gid://shopify/PriceList/us-guardrails";
        chaos.fake.addPriceList({
          id: US,
          name: "United States",
          currency: "USD",
          country: "US",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 5 },
          catalog: { id: "gid://shopify/MarketCatalog/us-guardrails", title: "US", __typename: "MarketCatalog" },
          prices: [],
        });
        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [US] } as never },
        });

        await prisma.variantIndex.updateMany({ where: { shopId }, data: { cost: 100n } });
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, neverBelowCost: true });

        const applied = await chaos.apply();

        // Costs are in dollars and so is this market: the guardrail can be checked, and
        // every sale price is above $1.00. Skipping the market here would be the #691
        // silence with a better excuse.
        expect(applied.messages.join("\n")).not.toMatch(/left at full price/);
        const rows = await prisma.variantChange.findMany({
          where: { runId: applied.runId, priceListGid: US },
        });
        expect(rows).toHaveLength(variantGids.length);
      },
    );
  });
});
