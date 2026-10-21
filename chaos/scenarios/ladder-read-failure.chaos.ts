/**
 * A wholesale baseline never says "no ladder" without anyone having looked (#1103).
 *
 * A campaign's capture caught a failed ladder read and recorded every wholesale baseline as
 * "no ladder". Until #704 every read failed, so every such baseline says so. The sync never
 * corrects one (it skips a price with a baseline), and a tiered revert clears the merchant's
 * quantity breaks on it.
 *
 * Through the campaign's real apply and preview, and the tiered writer and revert as the run
 * will call them, against a wholesale catalogue the fake prices by rule.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { money } from "../../app/lib/money/money";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, withChaos } from "../harness/scenario";

const LIST = { priceListGid: "gid://shopify/PriceList/ladder-read", name: "Trade", currency: "USD" };
const MERCHANTS = [
  { minimumQuantity: 1, amount: "63.00" },
  { minimumQuantity: 24, amount: "55.00" },
];
const TIERS = [
  { minimumQuantity: 1, discountBps: 0 },
  { minimumQuantity: 12, discountBps: 1000 },
];
const FLOOR = { minMarginPercent: 20, missingCost: "refuse" as const };
const failLadderReads = (chaos: ChaosContext) =>
  chaos.arm([{ fault: "server-error", match: (query: string) => query.includes("AnchorPriceListQuantityBreaks") }]);

async function onTrade(chaos: ChaosContext) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  chaos.fake.addPriceList({
    id: LIST.priceListGid,
    name: LIST.name,
    currency: LIST.currency,
    adjustment: { type: "PERCENTAGE_DECREASE", value: 30 },
    catalog: { id: "gid://shopify/CompanyLocationCatalog/ladder-read", title: "Trade", __typename: "CompanyLocationCatalog" },
    // The first variant at a price the merchant set, with their own quantity breaks: Shopify
    // keeps quantity breaks only on a fixed price. The second follows the list's rule.
    prices: [{ variantGid: variantGids[0], amount: "63.00", compareAt: null, originType: "FIXED" as const }],
  });
  // The merchant's own quantity breaks on the first variant.
  chaos.fake.ladders.set(`${LIST.priceListGid}|${variantGids[0]}`, MERCHANTS.map((rung) => ({ ...rung })));
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [LIST.priceListGid] } as never } });
}

const tradeBaselines = (shopId: string) =>
  prisma.baseline.findMany({ where: { shopId, priceListGid: LIST.priceListGid, surfaceKind: "MARKET", supersededAt: null }, orderBy: { variantGid: "asc" } });

describe("chaos: a wholesale catalogue whose ladders cannot be read", () => {
  it("is left uncaptured and said on a campaign's first apply, and captured with its ladder once it can be read", async () => {
    await withChaos("ladder-read-failure-capture", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await onTrade(chaos);

      failLadderReads(chaos);
      const applied = await chaos.apply();
      expect(applied.messages.join(" "), "the run did not say why Trade was not priced").toMatch(
        /Trade: its quantity breaks couldn't be read from Shopify, so its wholesale prices weren't recorded/,
      );
      expect(await tradeBaselines(shopId), "a baseline was recorded without its ladder being read").toEqual([]);
      chaos.heal();

      // Once the sale is over the catalogue's prices can be read again (they follow the store
      // price), and now its ladders can too: the merchant's on the first variant, and a known
      // "none" on the second.
      await chaos.revert();
      await previewCampaign(shopId, campaignId, { limit: 100, client: chaosAdminClient(chaos.server.endpoint()) });
      const [first, second] = await tradeBaselines(shopId);
      expect(first?.variantGid).toBe(variantGids[0]);
      expect(first?.ladderRead).toBe(true);
      expect(first?.quantityBreaks).toEqual([{ minimumQuantity: 1, amount: 6300 }, { minimumQuantity: 24, amount: 5500 }]);
      expect(second?.ladderRead).toBe(true);
      expect(second?.quantityBreaks).toBeNull();
    });
  });

  it("reads a baseline nobody read once, and a tiered revert never clears a ladder on one still unread", async () => {
    await withChaos("ladder-read-failure-legacy", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [withLadder, withoutLadder] = variantGids as [string, string];
      const client = chaosAdminClient(chaos.server.endpoint());
      await onTrade(chaos);
      // As every campaign recorded them before #704: "no ladder", read by nobody.
      const legacy = (variantGid: string, price: bigint) => ({
        shopId, variantGid, surfaceKind: "MARKET" as const, priceListGid: LIST.priceListGid, currency: "USD", basePrice: price, source: "AUTO_ENROLL" as const,
      });
      await prisma.baseline.createMany({ data: [legacy(withLadder, 6_300n), legacy(withoutLadder, 6_300n)] });

      // While reads still fail, a tiered sale is applied and ended: neither ladder is cleared.
      failLadderReads(chaos);
      await chaos.apply();
      const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");
      await prisma.variantIndex.updateMany({ where: { shopId }, data: { cost: 1_000n } });
      chaos.heal();
      const inputs = variantGids.map((variantGid) => ({ variantGid, title: variantGid, baseline: money(6_300, "USD"), cost: money(1_000, "USD") }));
      await applyQuantityBreaks(shopId, await chaos.latestRunId("APPLY"), LIST, inputs, TIERS, FLOOR, client);
      await chaos.revert();
      const reverted = await revertQuantityBreaks(shopId, await chaos.latestRunId("REVERT"), LIST, variantGids, FLOOR, client);
      expect(reverted?.clean, "a revert over ladders nobody read called itself clean").toBe(false);
      expect(reverted?.messages.join(" ")).toMatch(/2 products still have this campaign's quantity breaks, because the ones they had before were never recorded/);
      expect(chaos.fake.ladders.get(`${LIST.priceListGid}|${withoutLadder}`)?.length, "a ladder was cleared on a baseline nobody read").toBeGreaterThan(0);

      // The merchant puts their own breaks back on the first and lets the second follow the
      // list's rule again, as the message asks. With no campaign ladder left on the catalogue,
      // the next plan reads the unread ones once.
      await prisma.variantChange.updateMany({ where: { shopId, priceListGid: LIST.priceListGid }, data: { status: "REVERTED" } });
      chaos.fake.ladders.set(`${LIST.priceListGid}|${withLadder}`, MERCHANTS.map((rung) => ({ ...rung })));
      chaos.fake.ladders.delete(`${LIST.priceListGid}|${withoutLadder}`);
      await client.request("mutation { priceListFixedPricesDelete }", { priceListId: LIST.priceListGid, variantIds: [withoutLadder] });
      await previewCampaign(shopId, campaignId, { limit: 100, client });
      const [first, second] = await tradeBaselines(shopId);
      expect(first?.ladderRead, "a baseline nobody read was not read when it could be").toBe(true);
      expect(first?.quantityBreaks).toEqual([{ minimumQuantity: 1, amount: 6300 }, { minimumQuantity: 24, amount: 5500 }]);
      expect(second?.ladderRead).toBe(true);
      expect(second?.quantityBreaks).toBeNull();
    });
  });
});
