/**
 * The Markets card says how each market will be written, and the run then writes it that
 * way (#1109).
 *
 * The card told a storewide percentage sale that Europe "will be repriced with a single
 * market-wide 20% change rather than a price per product". The run never makes that change
 * for a campaign that also moves the base price: Europe's prices follow the base price, so a
 * percentage on top would apply the campaign twice (#260). It wrote a price per product, or
 * nothing at all, and the card had described a different campaign from the one that ran.
 * The run's check lived after the shared decision, in the run alone (rule 4).
 *
 * Each scenario previews the campaign as the campaign page does, applies it through the real
 * run, and compares the card's path and sentence with the path and reason the run reports
 * for the same market -- then checks the store for the path itself, since a report can be
 * wrong too.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { MarketSurfaceOutcome } from "../../app/services/campaigns/market-surfaces.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

/** What the run reported for each market it priced, as `applyMarketSurfaces` returned it. */
const { reported } = vi.hoisted(() => ({ reported: [] as MarketSurfaceOutcome[] }));

vi.mock("../../app/services/campaigns/market-surfaces.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/market-surfaces.server")>();
  return {
    ...actual,
    applyMarketSurfaces: async (...args: Parameters<typeof actual.applyMarketSurfaces>) => {
      const outcomes = await actual.applyMarketSurfaces(...args);
      reported.push(...outcomes);
      return outcomes;
    },
  };
});

const LIST = "gid://shopify/PriceList/path-agrees";

/** A market priced by the merchant's own 10% off the base price, and the campaign on it. */
async function percentageMarket(chaos: ChaosContext, { currency, country, base }: { currency: string; country: string; base: boolean }) {
  chaos.fake.addPriceList({
    id: LIST,
    name: "Europe",
    currency,
    country,
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/path-agrees", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
  await prisma.campaign.update({
    where: { id: chaos.fixture.campaignId },
    data: { surfaces: { base, priceLists: [LIST] } as never },
  });
  return chaos.fake.priceLists.find((list) => list.id === LIST)!;
}

/** The card's answer for the market, then the run's, for the same campaign. */
async function cardThenRun(chaos: ChaosContext) {
  const { shopId, campaignId } = chaos.fixture;
  const preview = await previewCampaign(shopId, campaignId, { client: chaosAdminClient(chaos.server.endpoint()) });
  const card = preview.markets.find((market) => market.priceListGid === LIST);
  expect(card, "the card left the market out").toBeDefined();
  expect(card!.refused, card!.explanation).toBe(false);

  reported.length = 0;
  const applied = await chaos.apply();
  await chaos.expectHonest(applied.runId);
  const ran = reported.filter((outcome) => outcome.priceListGid === LIST);
  expect(ran, "the run reported the market more than once, or not at all").toHaveLength(1);

  return { card: card!, ran: ran[0], applied };
}

const parentWritesOn = (chaos: ChaosContext) => chaos.fake.parentWrites.filter((write) => write.priceListGid === LIST);

describe("chaos: the Markets card and the run take the same path (#1109)", () => {
  it("a storewide sale on a percentage market in another currency: a price per product, said as the run says it", async () => {
    await withChaos("market-path-agrees-eur", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const list = await percentageMarket(chaos, { currency: "EUR", country: "DE", base: true });

      const { card, ran, applied } = await cardThenRun(chaos);

      expect(card.path, `the card said: ${card.explanation}`).toBe(ran.path);
      expect(ran.path).toBe("per-product");
      expect(ran.pathReason, "the run gave no reason for the path it took").toBeTruthy();
      expect(card.explanation, "the card gave a different reason from the run's").toContain(ran.pathReason!);
      expect(card.explanation, "the card promised a change the run does not make").not.toMatch(/single market-wide/);
      // And the run report says it, with the card's reason (#1115). It said nothing about
      // Europe unless a price there failed.
      expect(applied.messages, "the run report did not say how Europe was priced, or why").toContain(
        `Europe: priced product by product rather than with one market-wide change, because ${ran.pathReason}.`,
      );

      // The path itself, from the store: no percentage on the list, a price on every product.
      expect(parentWritesOn(chaos), "the run set a percentage after all").toEqual([]);
      expect(chaos.fake.fixedPricesOn(LIST).size).toBe(chaos.fixture.variantGids.length);

      // And the card's "undoing the campaign removes those prices".
      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      expect(chaos.fake.fixedPricesOn(LIST).size, "the revert left the campaign's prices on the list").toBe(0);
      expect(list.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });
    });
  });

  it("a storewide sale on a percentage market in the store's currency, which the base price already carries there", async () => {
    await withChaos("market-path-agrees-usd", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const list = await percentageMarket(chaos, { currency: "USD", country: "PR", base: true });
      const before = new Map(chaos.fixture.variantGids.map((gid) => [gid, chaos.fake.derivedPriceOf(gid, list)!]));

      const { card, ran, applied } = await cardThenRun(chaos);

      expect(card.path, `the card said: ${card.explanation}`).toBe(ran.path);
      expect(ran.path).toBe("per-product");
      expect(card.explanation, "the card gave a different reason from the run's").toContain(ran.pathReason!);
      expect(card.explanation, "the card promised a change the run does not make").not.toMatch(/single market-wide/);

      // Every price there landed through the base price, so the run wrote nothing to the list,
      // and the card did not promise it would.
      expect(parentWritesOn(chaos)).toEqual([]);
      expect(chaos.fake.fixedPricesOn(LIST).size).toBe(0);
      expect(card.explanation, "the card promised a price per product the run never writes").not.toMatch(/will get a price per product/);
      expect(applied.messages.join("\n")).toMatch(/Europe: already at the campaign's prices/);
      // Nothing was written here, so nothing was priced product by product (#1115).
      expect(applied.messages.join("\n")).not.toMatch(/priced product by product/);
      for (const gid of chaos.fixture.variantGids) {
        const cents = Math.round(Number(before.get(gid)!) * 100 * 0.8);
        expect(chaos.fake.priceOf(gid, LIST), `${gid} is not at the campaign's price in this market`).toBe((cents / 100).toFixed(2));
      }
    });
  });

  it("a campaign for the market alone: the market-wide change the card promises (#1094)", async () => {
    await withChaos("market-path-agrees-markets-only", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      await percentageMarket(chaos, { currency: "EUR", country: "DE", base: false });

      const { card, ran, applied } = await cardThenRun(chaos);

      expect(card.path, `the card said: ${card.explanation}`).toBe(ran.path);
      expect(ran.path).toBe("market-wide");
      expect(card.explanation).toMatch(/Europe will be repriced with a single market-wide 20% change/);
      // The report's own sentence for this path, unchanged by #1115's.
      expect(applied.messages.join("\n")).toMatch(/Europe: repriced with one market-wide change of/);
      expect(applied.messages.join("\n")).not.toMatch(/priced product by product/);
      expect(parentWritesOn(chaos)).toEqual([{ priceListGid: LIST, type: "PERCENTAGE_DECREASE", value: 28 }]);
    });
  });
});
