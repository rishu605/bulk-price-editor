/**
 * Downgrading mid-campaign (edge case E8).
 *
 * The single most important thing in the billing story, and the one place where getting
 * it wrong is not a bug but a revenue incident we caused. A merchant who drops to a
 * cheaper plan while a sale is running must still get their revert. A storefront left at
 * 40% off indefinitely because we stopped reverting is indefensible, and no amount of
 * "they downgraded" changes that — least of all in a public review.
 *
 * So these scenarios do the thing the code is meant to forbid, and check it still works.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

async function setPlan(chaos: ChaosContext, tier: "FREE" | "GROWTH" | "MARKETS" | "WHOLESALE") {
  await prisma.shop.update({
    where: { id: chaos.fixture.shopId },
    data: { planTier: tier, subscriptionStatus: tier === "FREE" ? "CANCELLED" : "ACTIVE" },
  });
}

describe("chaos: downgrading while a campaign is live", () => {
  it("still reverts every price after the plan is cancelled", async () => {
    await withChaos(
      "downgrade-revert",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -40 },
      async (chaos) => {
        const { variantGids, baseline } = chaos.fixture;

        await setPlan(chaos, "WHOLESALE");
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        expect(applied.verified).toBe(variantGids.length);

        // The card is declined and Shopify cancels the subscription. Everything the
        // merchant can *start* is now free-tier; everything already running must finish.
        //
        // The free limit is dropped below this catalogue on purpose. Without that the
        // campaign would fit the free plan anyway and the revert would succeed for a
        // reason that has nothing to do with the exemption being tested.
        await setPlan(chaos, "FREE");

        const { PLANS } = await import("../../app/lib/billing/plans");
        const original = PLANS.free.variantLimit;
        PLANS.free.variantLimit = 2;

        try {
          // Applying again is refused, which is the gate working...
          const blocked = await chaos.apply();
          expect(blocked.verified).toBe(0);
          expect(blocked.messages.join(" ")).toContain("2");

          // ...and reverting is not, which is the whole of E8.
          const reverted = await chaos.revert();
          await chaos.expectHonest(reverted.runId);
        } finally {
          PLANS.free.variantLimit = original;
        }

        // Every price back at its baseline. This is the assertion the whole ticket is
        // about: no storefront is left discounted because somebody stopped paying.
        for (const gid of variantGids) {
          const live = Number(chaos.fake.priceOf(gid)!.replace(".", ""));
          expect(live).toBe(baseline.get(gid));
        }
      },
    );
  });

  it("still reverts a campaign whose surfaces the new plan does not include", async () => {
    await withChaos(
      "downgrade-markets-revert",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/eu",
          name: "Europe",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
          prices: [],
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await setPlan(chaos, "MARKETS");
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: ["gid://shopify/PriceList/eu"] } as never },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Priced by whichever path the planner chose, not by the one this test expected.
        //
        // It used to assert five fixed prices, which quietly encoded a bug: the campaign
        // covers every product on the market at one percentage, so it is exactly the case
        // the market-wide path exists for, and the only reason five fixed prices appeared
        // is that eligibility was failing to recognise it. Pinning the count here made the
        // broken behaviour a requirement.
        //
        // What this scenario is actually about is the downgrade, so it asks the
        // path-agnostic question: is the market carrying our prices now, and is it clean
        // afterwards.
        //
        // Asked of the ledger rather than of the write log, because "reached the market"
        // and "wrote to the market" stopped being the same thing. A market that already
        // follows the base price is at the campaign's prices with no mutation at all
        // (#260), and counting writes reported that correct outcome as a failure — on one
        // chaos seed and not another, because whether the arithmetic lands exactly depends
        // on the prices the fixture happened to generate.
        //
        // The ledger is the record of what the campaign did, which is the question.
        const ledgered = await prisma.variantChange.findMany({
          where: {
            shopId,
            priceListGid: "gid://shopify/PriceList/eu",
            surfaceKind: "MARKET",
            status: "VERIFIED",
          },
          select: { variantGid: true },
        });
        expect(
          ledgered.length,
          "the campaign did not reach the market at all",
        ).toBeGreaterThan(0);

        // Down to a plan with no markets at all. The market prices we wrote are still
        // ours to undo — refusing here would strand a whole market on sale prices, which
        // is worse than the base-price case because the merchant is less likely to look.
        await setPlan(chaos, "GROWTH");

        const reverted = await chaos.revert();
        await chaos.expectHonest(reverted.runId);

        expect(chaos.fake.fixedPricesOn("gid://shopify/PriceList/eu").size).toBe(0);

        // And the list is back on the merchant's own percentage, not left on the
        // campaign's. A revert that cleared the fixed prices but left a -37% parent
        // adjustment behind would pass the line above and strand the whole market —
        // which is the exact failure this scenario was written to catch.
        const list = chaos.fake.priceLists.find((l) => l.id === "gid://shopify/PriceList/eu");
        expect(list?.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });
      },
    );
  });

  it("refuses to start a gated campaign, in words rather than by failing", async () => {
    await withChaos(
      "downgrade-refuses-start",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/eu",
          name: "Europe",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
          catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
          prices: [],
        });
        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await setPlan(chaos, "GROWTH");
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: ["gid://shopify/PriceList/eu"] } as never },
        });

        const result = await chaos.apply();

        // Not an error and not a failed run. A scheduled run that threw would surface as
        // "your sale failed", which reads far worse than "your plan does not cover this".
        expect(result.verified).toBe(0);
        expect(result.clean).toBe(true);
        expect(result.refusedByPlan).toBeDefined();
        expect(result.messages.join(" ")).toContain("Markets");

        // And crucially, nothing was written or half-written.
        expect(chaos.fake.writeLog).toHaveLength(0);
        expect(await prisma.variantChange.count({ where: { shopId } })).toBe(0);
      },
    );
  });

  it("does not gate a campaign that fits the smaller plan", async () => {
    await withChaos(
      "downgrade-still-runs",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        await setPlan(chaos, "FREE");

        // Five variants, base surface only. Free covers this, and gating it would make
        // the free tier an advertisement rather than a product.
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(applied.verified).toBe(chaos.fixture.variantGids.length);
      },
    );
  });

  it("refuses a campaign larger than the plan's variant limit", async () => {
    await withChaos(
      "downgrade-variant-cap",
      { catalog: { products: 12, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId } = chaos.fixture;

        await prisma.shop.update({
          where: { id: shopId },
          data: { planTier: "FREE", subscriptionStatus: "ACTIVE" },
        });

        // A limit below the catalogue, standing in for a free-tier store that has grown.
        const { PLANS } = await import("../../app/lib/billing/plans");
        const original = PLANS.free.variantLimit;
        PLANS.free.variantLimit = 5;

        try {
          const result = await chaos.apply();

          expect(result.verified).toBe(0);
          expect(result.messages.join(" ")).toContain("12");
          expect(chaos.fake.writeLog).toHaveLength(0);
        } finally {
          PLANS.free.variantLimit = original;
        }
      },
    );
  });
});
