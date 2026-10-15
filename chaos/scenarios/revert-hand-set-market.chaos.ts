/**
 * A revert puts a merchant's hand-set market price back (#930).
 *
 * Reverting deleted every market price the campaign had written. Right for a variant
 * whose market price followed the store price -- deleting the fixed price makes it follow
 * again -- and wrong for one the merchant had set by hand: on boltify-apps a ¥15,000
 * hand-set price came back as the ¥14,537 the list's percentage derived. Rule 6: a revert
 * recomputes without the campaign, it does not delete.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/eu-hand-set";

describe("chaos: reverting a campaign over a market with hand-set prices", () => {
  it("writes the hand-set prices back, and lets the derived ones follow the store price again", async () => {
    await withChaos("revert-hand-set-market", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [handA, handB, ...derived] = variantGids;

      // A -10% market, with two of its prices set by hand.
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: `${EUR}/catalog`, title: "EU", __typename: "MarketCatalog" },
        prices: [handA, handB].map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [EUR] } as never } });
      const before = new Map(derived.map((gid) => [gid, chaos.fake.priceOf(gid, EUR)]));

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.priceOf(handA, EUR)).toBe("40.00");
      const recorded = await prisma.baseline.findMany({ where: { shopId, priceListGid: EUR, supersededAt: null } });
      expect(recorded.filter((b) => b.handSet).map((b) => b.variantGid).sort()).toEqual([handA, handB].sort());

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      for (const gid of [handA, handB]) {
        expect(chaos.fake.priceOf(gid, EUR), `${gid}'s hand-set price was deleted instead of put back`).toBe("50.00");
        expect(chaos.fake.fixedPricesOn(EUR).has(gid)).toBe(true);
      }
      for (const gid of derived) {
        expect(chaos.fake.fixedPricesOn(EUR).has(gid), `${gid} was pinned instead of following the store price`).toBe(false);
        expect(chaos.fake.priceOf(gid, EUR)).toBe(before.get(gid));
      }
      // Written back through the ledger, under the revert run.
      const ledgered = await prisma.variantChange.findMany({ where: { runId: reverted.runId, priceListGid: EUR } });
      expect(ledgered.map((row) => [row.variantGid, row.status]).sort()).toEqual([[handA, "VERIFIED"], [handB, "VERIFIED"]].sort());
    });
  });

  // The baseline recorded the hand-set price and not its compare-at, so the revert wrote the
  // price back and cleared the strike-through the merchant had set on the list (#1039). A
  // market's is read from Shopify when its baseline is captured, a wholesale catalogue's from
  // the mirror, so both are walked.
  it.each([
    {
      kind: "a market",
      id: "gid://shopify/PriceList/eu-hand-set-struck",
      currency: "EUR",
      country: "DE" as string | undefined,
      catalog: { id: "gid://shopify/MarketCatalog/eu-struck", title: "EU", __typename: "MarketCatalog" },
    },
    {
      kind: "a wholesale catalogue",
      id: "gid://shopify/PriceList/trade-hand-set-struck",
      currency: "USD",
      country: undefined,
      catalog: { id: "gid://shopify/CompanyLocationCatalog/struck", title: "Trade", __typename: "CompanyLocationCatalog" },
    },
  ])("puts a hand-set price's strike-through back with it on $kind, and leaves one that had none without", async (list) => {
    await withChaos(`revert-hand-set-compare-at-${list.currency}`, { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [struck, plain, derived] = variantGids;

      chaos.fake.addPriceList({
        id: list.id,
        name: list.kind,
        currency: list.currency,
        ...(list.country ? { country: list.country } : {}),
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: list.catalog,
        prices: [
          { variantGid: struck, amount: "50.00", compareAt: "65.00", originType: "FIXED" as const },
          { variantGid: plain, amount: "50.00", compareAt: null, originType: "FIXED" as const },
        ],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      // A sale with its own strike-through, so the revert has the merchant's to put back
      // rather than one the sale left alone.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { base: true, priceLists: [list.id] } as never, compareAtPolicy: { kind: "set-to-baseline" } as never },
      });
      const before = chaos.fake.priceOf(derived, list.id);

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(list.id).get(struck), "the sale did not replace the merchant's strike-through").toEqual({ amount: "40.00", compareAt: "50.00" });
      const recorded = await prisma.baseline.findMany({ where: { shopId, priceListGid: list.id, supersededAt: null } });
      expect(new Map(recorded.map((b) => [b.variantGid, b.baseCompareAt])), "the baseline did not record the compare-at").toEqual(
        new Map([[struck, 6_500n], [plain, null], [derived, null]]),
      );

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      expect(chaos.fake.fixedPricesOn(list.id).get(struck), "the merchant's strike-through was cleared").toEqual({ amount: "50.00", compareAt: "65.00" });
      expect(chaos.fake.fixedPricesOn(list.id).get(plain), "a strike-through appeared where the merchant had none").toEqual({ amount: "50.00", compareAt: null });
      expect(chaos.fake.fixedPricesOn(list.id).has(derived)).toBe(false);
      expect(chaos.fake.priceOf(derived, list.id)).toBe(before);

      // Ledgered as written: the compare-at is part of the instruction, not left to the list.
      const ledgered = await prisma.variantChange.findMany({ where: { runId: reverted.runId, priceListGid: list.id } });
      expect(new Map(ledgered.map((row) => [row.variantGid, [row.intendedCompareAt, row.intendedCompareAtSet, row.status]]))).toEqual(
        new Map([[struck, [6_500n, true, "VERIFIED"]], [plain, [null, true, "VERIFIED"]]]),
      );
    });
  });
});
