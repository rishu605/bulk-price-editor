/**
 * Markets changing under a running campaign (edge case E15).
 *
 * A merchant deletes a market on Wednesday. A campaign that was pricing into it has
 * nowhere to write. The wrong outcome is the obvious one: the run fails partway with a
 * Shopify error about a price list id, which tells the merchant nothing about which sale
 * is now wrong or what to do about it.
 *
 * The right one is that the rest of the campaign runs normally, the market that vanished
 * is named in the report, and the merchant is asked a question they can actually answer.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/eu";

function addEuMarket(chaos: ChaosContext, currency = "EUR") {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency,
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
}

async function sync(chaos: ChaosContext) {
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  const { chaosAdminClient } = await import("../harness/http-client");
  return syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
}

describe("chaos: markets changing while campaigns run", () => {
  it("keeps running when a targeted market is deleted, and says which one", async () => {
    await withChaos(
      "market-deleted",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        // The merchant deletes the market in Shopify, mid-campaign.
        chaos.fake.priceLists.length = 0;
        const resync = await sync(chaos);

        expect(resync.questions).toBe(1);

        const notice = await prisma.topologyNotice.findFirstOrThrow({
          where: { shopId, resolvedAt: null },
        });
        expect(notice.kind).toBe("removed");
        // The question names the campaign, because "a market was deleted" is not
        // actionable and "your Summer sale can no longer reach Europe" is.
        expect(notice.campaignIds).toEqual([campaignId]);
        expect(notice.detail).toContain("Europe");

        // The run itself proceeds. Base prices are written and verified exactly as they
        // would have been, which is the whole point: one deleted market must not cost
        // the merchant the rest of their sale.
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        expect(applied.verified).toBe(variantGids.length);
        expect(applied.messages.join(" ")).toContain("no longer exists");
      },
    );
  });

  it("offers a new market to campaigns rather than joining them to it", async () => {
    await withChaos(
      "market-added",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        // A second market appears. Which countries see a sale is a commercial decision,
        // so the campaign is not silently extended to it.
        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/jp",
          name: "Japan",
          currency: "JPY",
          country: "JP",
          adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
          catalog: { id: "gid://shopify/MarketCatalog/jp", title: "JP", __typename: "MarketCatalog" },
          prices: [],
        });
        await sync(chaos);

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect((campaign.surfaces as { priceLists: string[] }).priceLists).toEqual([EU]);

        const notice = await prisma.topologyNotice.findFirstOrThrow({
          where: { shopId, kind: "added", resolvedAt: null },
        });

        // And answering the question does what it says.
        const { resolveNotice } = await import("../../app/services/markets-topology.server");
        await resolveNotice(shopId, notice.id, "extended");

        const extended = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect((extended.surfaces as { priceLists: string[] }).priceLists).toContain(
          "gid://shopify/PriceList/jp",
        );
      },
    );
  });

  it("does not ask the same question twice, however often it polls", async () => {
    await withChaos(
      "market-notice-once",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        chaos.fake.priceLists.length = 0;
        await sync(chaos);
        await sync(chaos);
        await sync(chaos);

        // One notice, not three. The mechanism is that the mirror moves on: once the
        // deleted market is gone from it, later syncs compare like with like and find
        // nothing changed. Worth asserting anyway — if the mirror ever failed to update,
        // a poll every fifteen minutes would stack up ninety-six copies of this question
        // by morning, which is how a merchant learns to ignore them.
        const notices = await prisma.topologyNotice.findMany({ where: { shopId } });
        expect(notices).toHaveLength(1);
      },
    );
  });

  it("does not raise the question again once it has been answered", async () => {
    await withChaos(
      "market-notice-resolved",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        chaos.fake.priceLists.length = 0;
        await sync(chaos);

        const notice = await prisma.topologyNotice.findFirstOrThrow({
          where: { shopId, resolvedAt: null },
        });

        const { resolveNotice } = await import("../../app/services/markets-topology.server");
        await resolveNotice(shopId, notice.id, "removed");

        // The campaign no longer targets the market it was told about.
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect((campaign.surfaces as { priceLists: string[] }).priceLists).toEqual([]);

        await sync(chaos);
        expect(await prisma.topologyNotice.count({ where: { shopId, resolvedAt: null } })).toBe(0);
      },
    );
  });

  it("asks again when the same thing happens a second time", async () => {
    await withChaos(
      "market-notice-recurs",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        chaos.fake.priceLists.length = 0;
        await sync(chaos);

        const first = await prisma.topologyNotice.findFirstOrThrow({
          where: { shopId, resolvedAt: null },
        });
        const { resolveNotice } = await import("../../app/services/markets-topology.server");
        await resolveNotice(shopId, first.id, "ignored");

        // The merchant restores the market and targets it again, then deletes it again.
        // An answered question must not silence the same problem happening afresh --
        // "we already told them once" is not a reason to stop telling them.
        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        chaos.fake.priceLists.length = 0;
        await sync(chaos);

        // Two removal notices: one answered, one open. Scoped to the kind because
        // restoring the market legitimately raises an "added" question of its own.
        expect(
          await prisma.topologyNotice.count({
            where: { shopId, kind: "removed", resolvedAt: null },
          }),
        ).toBe(1);
        expect(await prisma.topologyNotice.count({ where: { shopId, kind: "removed" } })).toBe(2);
      },
    );
  });

  it("records a currency change, which reinterprets every price on the market", async () => {
    await withChaos(
      "market-currency",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await sync(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [EU] } as never },
        });

        // 2000 minor units was €20.00 and is now ¥2,000. Nothing we hold became wrong,
        // exactly — it started meaning something else.
        chaos.fake.priceLists[0].currency = "JPY";
        await sync(chaos);

        const notice = await prisma.topologyNotice.findFirstOrThrow({
          where: { shopId, kind: "currency-changed", resolvedAt: null },
        });
        expect(notice.detail).toContain("EUR");
        expect(notice.detail).toContain("JPY");

        // And it is in the audit log, because "when did this market change currency" is
        // exactly the question asked after a price looks wrong.
        const logged = await prisma.auditLogEntry.findFirst({
          where: { shopId, action: "market.currency-changed" },
        });
        expect(logged).not.toBeNull();
      },
    );
  });
});
