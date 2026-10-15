/**
 * "Revert this variant" on a list priced by a percentage lets the variant follow it again
 * (#1002).
 *
 * It wrote the recomputed price as a fixed price. The number was right on the day, and the
 * variant was pinned: from then on it ignored the list's percentage, so a change to its store
 * price moved every other variant in Japan and not this one. A whole-campaign revert deletes
 * the campaign's fixed price instead (#930), and a variant revert now does the same -- except
 * where the merchant had set the price by hand before the sale, which is written back, and
 * where another campaign now prices the variant, whose price is written.
 *
 * Asserted against what the store holds: whether the list stores a fixed price for the
 * variant, and what a shopper there pays once the store price moves.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

/** A +20% yen list: no fixed prices of its own, except where a test sets one by hand. */
const JP = "gid://shopify/PriceList/jp-variant-follows";
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

async function withJapan(chaos: ChaosContext, handSet: Record<string, string> = {}, handSetCompareAt: Record<string, string> = {}) {
  const { shopId, campaignId } = chaos.fixture;
  chaos.fake.addPriceList({
    id: JP,
    name: "Japan",
    currency: "JPY",
    country: "JP",
    adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
    catalog: { id: `${JP}/catalog`, title: "JP", __typename: "MarketCatalog" },
    prices: Object.entries(handSet).map(([variantGid, amount]) => ({
      variantGid,
      amount,
      compareAt: handSetCompareAt[variantGid] ?? null,
      originType: "FIXED" as const,
    })),
  });
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      surfaces: { base: true, priceLists: [JP] } as never,
      // A strike-through, so the sale is a fixed price on Japan for every variant rather
      // than one the list derives from the sale's store price -- the price this is about.
      compareAtPolicy: { kind: "set-to-baseline" } as never,
    },
  });
}

const japan = (chaos: ChaosContext) => chaos.fake.priceLists.find((list) => list.id === JP)!;

/** The variant's store price moved by hand, as a merchant would. */
function reprice(chaos: ChaosContext, variantGid: string, price: string) {
  chaos.fake.variants.get(variantGid)!.price = price;
}

describe("chaos: reverting one variant on a list priced by a percentage (#1002)", () => {
  it("removes the campaign's fixed price, so the variant follows the list's percentage again", async () => {
    await withChaos("variant-revert-follows-list", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withJapan(chaos);
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, JP)]));

      await chaos.expectHonest((await chaos.apply()).runId);
      for (const gid of variantGids) {
        expect(chaos.fake.fixedPricesOn(JP).has(gid), "the sale wrote no fixed price, so this tests nothing").toBe(true);
      }
      const [victim, ...others] = variantGids;

      const result = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      expect(result.outcome?.clean).toBe(true);
      await chaos.expectHonest(result.outcome!.runId);

      expect(chaos.fake.fixedPricesOn(JP).has(victim), "the variant was pinned at a fixed price").toBe(false);
      expect(chaos.fake.priceOf(victim, JP), "back to what Japan derived before the sale").toBe(before.get(victim));
      for (const gid of others) expect(chaos.fake.fixedPricesOn(JP).has(gid), "a run over one variant moved another").toBe(true);

      // Following, not frozen: its store price moves, and so does its price in Japan.
      reprice(chaos, victim, "99.00");
      expect(chaos.fake.priceOf(victim, JP)).toBe(chaos.fake.derivedPriceOf(victim, japan(chaos)));
      expect(chaos.fake.priceOf(victim, JP)).not.toBe(before.get(victim));

      // Ledgered under the revert before the delete, and confirmed by reading the list back.
      const rows = await prisma.variantChange.findMany({ where: { runId: result.outcome!.runId, priceListGid: JP } });
      expect(rows.map((row) => [row.variantGid, row.status, row.intendedPrice])).toEqual([[victim, "VERIFIED", null]]);
      expect(result.message).toContain("Recomputed without it and verified: the base price and Japan (JPY).");

      // The mirror holds no fixed price for it either, as a sync would have it.
      expect(await prisma.priceSurfaceEntry.count({ where: { shopId, priceListGid: JP, variantGid: victim } })).toBe(0);
    });
  });

  it("writes back a price the merchant set by hand before the sale, as a fixed price", async () => {
    await withChaos("variant-revert-hand-set-market", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const [handSet, derived] = variantGids;
      await withJapan(chaos, { [handSet]: "1500" });
      const before = chaos.fake.priceOf(derived, JP);

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.priceOf(handSet, JP), "the sale never reached the hand-set price").toBe("1200");

      const kept = await revertVariant(shopId, campaignId, handSet, client, { actor: "chaos" });
      await chaos.expectHonest(kept.outcome!.runId);
      expect(chaos.fake.fixedPricesOn(JP).get(handSet), "the merchant's own price was deleted").toEqual({ amount: "1500", compareAt: null });
      // Still the merchant's, whatever the store price does.
      reprice(chaos, handSet, "99.00");
      expect(chaos.fake.priceOf(handSet, JP)).toBe("1500");

      // The other one, on the same list, follows the list.
      await chaos.expectHonest((await revertVariant(shopId, campaignId, derived, client, { actor: "chaos" })).outcome!.runId);
      expect(chaos.fake.fixedPricesOn(JP).has(derived)).toBe(false);
      expect(chaos.fake.priceOf(derived, JP)).toBe(before);
    });
  });

  it("writes back the strike-through the merchant had set on that hand-set price (#1039)", async () => {
    await withChaos("variant-revert-hand-set-compare-at", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const [handSet] = variantGids;
      await withJapan(chaos, { [handSet]: "1500" }, { [handSet]: "1800" });

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(JP).get(handSet), "the sale never replaced the strike-through").toEqual({ amount: "1200", compareAt: "1500" });

      const kept = await revertVariant(shopId, campaignId, handSet, client, { actor: "chaos" });
      await chaos.expectHonest(kept.outcome!.runId);
      expect(chaos.fake.fixedPricesOn(JP).get(handSet), "the merchant's strike-through was cleared").toEqual({ amount: "1500", compareAt: "1800" });
    });
  });

  it("writes the price of a campaign that still prices the variant there", async () => {
    await withChaos("variant-revert-follows-overlap", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withJapan(chaos);
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, JP)]));
      await chaos.expectHonest((await chaos.apply()).runId);

      // A lower sale on the same list, which the fixture's sale wins everywhere.
      const { createCampaign } = await import("../../app/services/campaigns/model.server");
      const { runCampaign } = await import("../../app/services/campaigns/run.server");
      const lower = await createCampaign(shopId, {
        name: "chaos/variant-revert-follows-overlap lower",
        priority: 100,
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      });
      await prisma.campaign.update({ where: { id: lower.id }, data: { surfaces: { base: true, priceLists: [JP] } as never } });
      await runCampaign(shopId, lower.id, client, { actor: "chaos", verifySampleRate: 1 });

      // Taken out of the higher sale, the variant is the lower one's: its price, held fixed.
      const [victim] = variantGids;
      const result = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      await chaos.expectHonest(result.outcome!.runId);
      const row = await prisma.variantChange.findFirstOrThrow({ where: { runId: result.outcome!.runId, priceListGid: JP } });
      expect(row.intendedPrice, "the lower sale's price was dropped for the list's").not.toBeNull();
      expect(chaos.fake.fixedPricesOn(JP).has(victim)).toBe(true);
      expect(chaos.fake.priceOf(victim, JP)).not.toBe(before.get(victim));
    });
  });

  it("says Japan is not confirmed when the delete fails, and a second press finishes it", async () => {
    await withChaos("variant-revert-follows-fails", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withJapan(chaos);
      await chaos.expectHonest((await chaos.apply()).runId);
      const [victim] = variantGids;

      chaos.arm([{ fault: "server-error", match: (query) => query.includes("priceListFixedPricesDelete") }]);
      const failed = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      chaos.heal();
      expect(chaos.fake.fixedPricesOn(JP).has(victim), "the delete went through, so this tests nothing").toBe(true);
      // Not clean, and the run says so: rule 5 holds for a run over one variant too (#1001).
      expect(failed.outcome?.clean).toBe(false);
      expect((await prisma.campaignRun.findUniqueOrThrow({ where: { id: failed.outcome!.runId } })).status).toBe("PARTIAL");
      expect(failed.message).toMatch(/verified: the base price\. Not confirmed: Japan \(JPY\)\..*Revert this variant again/);
      // Whatever Japan holds now, the mirror does not claim to know.
      expect((await prisma.priceSurfaceEntry.findFirst({ where: { shopId, priceListGid: JP, variantGid: victim } }))?.livePrice ?? null).toBeNull();

      const again = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      await chaos.expectHonest(again.outcome!.runId);
      expect(chaos.fake.fixedPricesOn(JP).has(victim)).toBe(false);
    });
  });

  it("ledgers the delete before sending it, and does not call it verified until the list is read back without it", async () => {
    await withChaos("variant-revert-follows-unconfirmed", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withJapan(chaos);
      await chaos.expectHonest((await chaos.apply()).runId);
      const [victim] = variantGids;

      // A delete Shopify answers without an error and without carrying out: the fake cannot
      // otherwise say "accepted, and still there". It also looks, as the request arrives, for
      // the ledger row that has to be there first (I4).
      const fake = chaos.fake as unknown as { priceListFixedPricesDelete: (variables: Record<string, unknown>) => unknown };
      const ledgeredFirst: boolean[] = [];
      fake.priceListFixedPricesDelete = async () => {
        ledgeredFirst.push(
          (await prisma.variantChange.count({ where: { shopId, variantGid: victim, priceListGid: JP, status: "PENDING", run: { kind: "REVERT" } } })) === 1,
        );
        return { data: { priceListFixedPricesDelete: { deletedFixedPriceVariantIds: [], userErrors: [] } } };
      };

      const result = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      expect(ledgeredFirst, "the delete was sent before its ledger row existed").toEqual([true]);
      expect(chaos.fake.fixedPricesOn(JP).has(victim)).toBe(true);
      expect(result.outcome?.clean, "a delete nobody read back was called clean").toBe(false);
      const row = await prisma.variantChange.findFirstOrThrow({ where: { runId: result.outcome!.runId, priceListGid: JP } });
      expect(row.status).toBe("FAILED");
      expect(row.failureReason).toMatch(/still holds a fixed price/);
      expect(result.message).toMatch(/Not confirmed: Japan \(JPY\)/);
    });
  });
});
