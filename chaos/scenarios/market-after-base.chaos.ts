/**
 * Apply prices a market even when the store price is already right (#841).
 *
 * Markets used to be planned only for the variants whose store price the run was about to
 * write. Once the store price was right, Apply never looked at a market again -- one added
 * to a running campaign, one a guardrail skipped, one whose write failed -- and reported
 * "all verified" while it stayed at full price.
 *
 * Two things must not come with the fix. A market whose price follows the store price,
 * added after the store price moved, must not be discounted a second time from a "before"
 * that is already the sale price (#259). And a resume must not re-send the market prices
 * that already landed.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const SPEC = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 };
const EUR = "gid://shopify/PriceList/eu-after-base";
const GBP = "gid://shopify/PriceList/gb-after-base";

/** A market with every variant's price set by hand, so it does not follow the store price. */
function handSetMarket(chaos: ChaosContext, id: string, currency: string, country: string, amount: string) {
  chaos.fake.addPriceList({
    id,
    name: `${country} hand-set`,
    currency,
    country,
    adjustment: null,
    catalog: { id: `${id}/catalog`, title: country, __typename: "MarketCatalog" },
    prices: chaos.fixture.variantGids.map((variantGid) => ({ variantGid, amount, compareAt: null, originType: "FIXED" as const })),
  });
}

async function targetMarkets(chaos: ChaosContext, priceLists: string[]) {
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
  await prisma.campaign.update({
    where: { id: chaos.fixture.campaignId },
    data: { surfaces: { base: true, priceLists } as never },
  });
}

const marketRows = (runId: string, priceListGid: string) => prisma.variantChange.findMany({ where: { runId, priceListGid } });

describe("chaos: Apply prices a market once the store price is already right", () => {
  it("prices a hand-set market added to a running campaign", async () => {
    await withChaos("market-after-base-added", SPEC, async (chaos) => {
      const { variantGids } = chaos.fixture;

      const first = await chaos.apply();
      await chaos.expectHonest(first.runId);

      handSetMarket(chaos, EUR, "EUR", "DE", "50.00");
      await targetMarkets(chaos, [EUR]);

      const preview = await previewCampaign(chaos.fixture.shopId, chaos.fixture.campaignId, {
        client: chaosAdminClient(chaos.server.endpoint()),
      });
      expect(preview.markets.map((m) => m.priceListGid), "the preview left out a market the run prices").toEqual([EUR]);

      const second = await chaos.apply();
      await chaos.expectHonest(second.runId);
      const rows = await marketRows(second.runId, EUR);
      expect(rows.map((row) => row.status), "the market was never planned: the store price was already right").toEqual(
        variantGids.map(() => "VERIFIED"),
      );
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid, EUR)).toBe("40.00");
    });
  });

  it("does not discount a market twice whose price follows a store price the campaign already moved", async () => {
    await withChaos("market-after-base-relative", SPEC, async (chaos) => {
      const { variantGids } = chaos.fixture;

      await chaos.apply();
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: `${EUR}/catalog`, title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      await targetMarkets(chaos, [EUR]);
      // What a shopper in Germany pays now: already the sale, through the store price.
      const following = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, EUR)]));

      const second = await chaos.apply();
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, EUR), "the sale price was recorded as 'before' and discounted again").toBe(following.get(gid));
      }
      expect(await prisma.baseline.count({ where: { shopId: chaos.fixture.shopId, priceListGid: EUR, variantGid: { in: variantGids } } }), "a sale price was stored as a baseline").toBe(0);
      expect(second.messages.join("\n")).toMatch(
        new RegExp(`Europe: ${variantGids.length} variants not priced separately\\. Their price here follows the store price`),
      );
    });
  });

  it("on a resume, retries the market that failed and leaves the one that landed", async () => {
    await withChaos("market-after-base-resume", SPEC, async (chaos) => {
      const { variantGids } = chaos.fixture;
      handSetMarket(chaos, EUR, "EUR", "DE", "50.00");
      handSetMarket(chaos, GBP, "GBP", "GB", "45.00");
      await targetMarkets(chaos, [EUR, GBP]);

      // The British market's writes fail; the German one's land.
      chaos.arm([
        {
          fault: "server-error",
          match: (query, variables) => query.includes("priceListFixedPricesAdd") && variables.priceListId === GBP,
        },
      ]);
      const first = await chaos.apply();
      chaos.heal();
      expect((await marketRows(first.runId, EUR)).every((row) => row.status === "VERIFIED")).toBe(true);
      expect((await marketRows(first.runId, GBP)).some((row) => row.status === "VERIFIED"), "the fault did not take").toBe(false);
      expect(chaos.fake.priceOf(variantGids[0], GBP)).toBe("45.00");

      const resumed = await chaos.apply({ actor: "chaos", resume: true });
      expect((await marketRows(resumed.runId, GBP)).map((row) => row.status), "the failed market was never retried").toEqual(
        variantGids.map(() => "VERIFIED"),
      );
      expect(await marketRows(resumed.runId, EUR), "the resume re-sent market prices that had landed").toHaveLength(0);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, GBP)).toBe("36.00");
        expect(chaos.fake.priceOf(gid, EUR)).toBe("40.00");
      }
    });
  });

  it("leaves a market to the campaign that wins it: a lower sale neither prices nor ends it", async () => {
    await withChaos("market-after-base-overlap", SPEC, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      handSetMarket(chaos, EUR, "EUR", "DE", "50.00");
      await targetMarkets(chaos, [EUR]);

      // A, the fixture campaign (-20%), wins every variant; B (-10%) sits under it on the same market.
      await chaos.expectHonest((await chaos.apply()).runId);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid, EUR)).toBe("40.00");

      const { createCampaign } = await import("../../app/services/campaigns/model.server");
      const { runCampaign } = await import("../../app/services/campaigns/run.server");
      const lower = await createCampaign(shopId, {
        name: "chaos/market-after-base-overlap lower",
        priority: 100,
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      });
      await prisma.campaign.update({ where: { id: lower.id }, data: { surfaces: { base: true, priceLists: [EUR] } as never } });
      const client = chaosAdminClient(chaos.server.endpoint());
      const applied = await runCampaign(shopId, lower.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(await marketRows(applied.runId, EUR), "the lower sale ledgered market prices it does not win").toHaveLength(0);

      // Ending the lower sale must leave the higher one's market prices where they are.
      await runCampaign(shopId, lower.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, EUR), "ending the lower sale took the higher sale off the market").toBe("40.00");
      }
    });
  });
});
