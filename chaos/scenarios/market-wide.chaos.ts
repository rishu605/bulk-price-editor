/**
 * Repricing a whole market with one mutation instead of hundreds.
 *
 * The optimisation is worth having — a 300-product market goes from two chunked writes
 * to a single call — but the interesting tests here are the ones where it is *refused*.
 * A parent adjustment moves every price on the list, so taking it when the campaign
 * covers only part of the market silently reprices the merchant's whole catalogue there
 * while the run reports success.
 *
 * The verdict still applies in full: every variant is ledgered before the write and
 * verified against what Shopify actually derived afterwards. That last part is not a
 * formality here. On the per-product path we send a price and Shopify stores it. Here
 * we send a percentage and Shopify computes the prices, rounding its own way — so a
 * handful can land a minor unit from what the ledger promised, and those get corrected
 * with an exact price rather than being marked verified on trust.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/eu";

/** A relative EUR market carrying the merchant's own 10% discount. */
function addEuMarket(chaos: ChaosContext) {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency: "EUR",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
}

async function targetEu(campaignId: string) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [EU] } as never },
  });
}

async function syncMarkets(chaos: ChaosContext) {
  const { syncMarkets: sync } = await import("../../app/services/markets-sync.server");
  const { chaosAdminClient } = await import("../harness/http-client");
  await sync(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
}

describe("chaos: repricing a market with one mutation", () => {
  it("uses a single market-wide change for a uniform campaign, and undoes it", async () => {
    await withChaos(
      "market-wide",
      { catalog: { products: 40, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // One mutation for forty products, instead of a price each.
        expect(chaos.fake.parentWrites).toHaveLength(1);

        // A minority still get an exact price. Sending a percentage means Shopify
        // computes each price itself, rounding its own way from a converted base price
        // we never see, so some land a minor unit from what the ledger promised. Those
        // are corrected rather than marked verified on trust — which is what keeps the
        // shortcut honest, and is why the count is asserted as a minority rather than
        // as zero.
        const corrections = chaos.fake.fixedPricesOn(EU).size;
        expect(corrections).toBeLessThan(variantGids.length / 2);

        // The campaign's 20% composed with the merchant's own 10%, not replacing it.
        // Writing 20% here would raise every European price by 8% while reporting the
        // campaign applied correctly.
        expect(chaos.fake.parentWrites[0]).toMatchObject({
          priceListGid: EU,
          type: "PERCENTAGE_DECREASE",
          value: 28,
        });

        // Every variant still ledgered and verified individually. The shortcut is in
        // the number of requests, never in what the merchant is told.
        const rows = await prisma.variantChange.findMany({
          where: { runId: applied.runId, surfaceKind: "MARKET" },
        });
        expect(rows).toHaveLength(variantGids.length);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);

        // And the market-wide change itself is ledgered, holding the one thing that
        // exists nowhere else once it is overwritten: the merchant's own percentage.
        const change = await prisma.priceListChange.findFirstOrThrow({
          where: { runId: applied.runId, priceListGid: EU },
        });
        expect(change.priorAdjustmentBps).toBe(-1000);
        expect(change.appliedAdjustmentBps).toBe(-2800);
        expect(change.status).toBe("VERIFIED");

        // ------------------------------------------------------------ revert
        await chaos.revert();

        // Back to the merchant's own 10%, restored from the ledger rather than
        // computed as an inverse.
        expect(chaos.fake.parentWrites.at(-1)).toMatchObject({
          type: "PERCENTAGE_DECREASE",
          value: 10,
        });
      },
    );
  });

  it("does not compound when the same campaign is applied twice", async () => {
    await withChaos(
      "market-wide-reapply",
      { catalog: { products: 10, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        // A market at parity with the base price, in the same currency. Chosen so the
        // campaign's arithmetic and Shopify's agree exactly and no product needs a
        // correcting price — which is what lets the *second* apply take the
        // market-wide path again and actually exercise the compounding guard. With a
        // market that produces corrections, the re-apply falls back to per-product
        // prices and this test would pass without testing anything.
        const parity = "gid://shopify/PriceList/parity";
        chaos.fake.addPriceList({
          id: parity,
          name: "Wholesale",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
          catalog: {
            id: "gid://shopify/MarketCatalog/parity",
            title: "Wholesale",
            __typename: "MarketCatalog",
          },
          prices: [],
        });

        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [parity] } as never },
        });

        await chaos.apply();
        expect(chaos.fake.fixedPricesOn(parity).size).toBe(0);

        // The merchant deepens the sale and applies again. Without this the second run
        // finds every price already correct, plans nothing, and the test would pass
        // without the market being re-planned at all.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            ruleRows: [
              { segmentIds: [], rule: { kind: "percent-change", percent: -30 } },
            ] as never,
          },
        });

        const again = await chaos.apply();
        await chaos.expectHonest(again.runId);

        // The path really was taken twice, so the assertion below is about the second
        // change rather than still looking at the first.
        expect(chaos.fake.parentWrites.length).toBeGreaterThan(1);

        // 30% off the market's baseline — not 30% off the 20% already applied. The
        // prior adjustment comes from the ledger, which remembers what the market's
        // own percentage was before this campaign ever touched it. Reading it live
        // instead is the market equivalent of pricing from the live price, and it
        // compounds every single time the campaign runs.
        expect(chaos.fake.parentWrites.at(-1)).toMatchObject({
          type: "PERCENTAGE_DECREASE",
          value: 30,
        });
      },
    );
  });

  it("falls back to a price per product when the campaign covers only part of a market", async () => {
    await withChaos(
      "market-wide-partial",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);

        // A campaign scoped to half the catalogue by its own filter — the ordinary
        // case, not a special mode. A market-wide percentage would reprice the other
        // half too: products this campaign was never pointed at, on a live storefront,
        // with the run reporting success.
        const inScope = variantGids.slice(0, 3);
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: { in: inScope } },
          data: { tags: ["HALF"] },
        });

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [EU] } as never,
            schedule: {
              ...(campaign.schedule as object),
              ast: { groups: [{ conditions: [{ field: "tag", value: "HALF" }] }] },
            } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);
        expect(chaos.fake.fixedPricesOn(EU).size).toBe(3);
      },
    );
  });

  it("falls back when rounding makes the change something other than one percentage", async () => {
    await withChaos(
      "market-wide-rounded",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId);

        // Charm-99 pricing perturbs each product individually. The rule still reads as
        // a uniform 20%, which is exactly why eligibility is proven from the finished
        // plan rather than predicted from the rule.
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            schedule: { ...(campaign.schedule as object), rounding: "charm99" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);
        expect(chaos.fake.fixedPricesOn(EU).size).toBeGreaterThan(0);
      },
    );
  });

  it("falls back when the market already has prices set on individual products", async () => {
    await withChaos(
      "market-wide-overrides",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        // The merchant priced one product by hand. A market-wide percentage does not
        // override it, so that product would keep its old price while every other one
        // moved — a half-applied campaign reporting as fully applied.
        chaos.fake.priceLists.find((l) => l.id === EU)!.prices.push({
          variantGid: variantGids[0],
          amount: "49.00",
          compareAt: null,
          originType: "FIXED",
        });

        await syncMarkets(chaos);
        await targetEu(campaignId);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);
      },
    );
  });

  it("falls back for a strike-through, which a market-wide percentage cannot express", async () => {
    await withChaos(
      "market-wide-compare-at",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [EU] } as never,
            compareAtPolicy: { kind: "set-to-baseline" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Taking the shortcut here would apply the right price with no strike-through
        // at all, and the strike-through is the entire point of a sale.
        expect(chaos.fake.parentWrites).toHaveLength(0);
        const prices = chaos.fake.fixedPricesOn(EU);
        expect([...prices.values()].every((price) => price.compareAt !== null)).toBe(true);
      },
    );
  });
});
