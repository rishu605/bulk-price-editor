/**
 * Reverting one variant out of a sale that also prices a market (#763).
 *
 * "Revert this variant" told the merchant its price had been "recomputed without it and
 * verified" -- true of the base price only. Scoped runs skipped markets outright, so the
 * variant kept its sale price in every market catalogue until the whole campaign ended,
 * and a later full apply never repaired it: the variant was no longer writable.
 *
 * And the scoped write held nothing: its occurrence key was unique per click and it never
 * took the campaign's claim, so it could run at the same moment as a full apply of the
 * same campaign (rule 2).
 *
 * A fixed euro list at €50 a variant, so every market price is a number this campaign
 * writes and the fake stores.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/eu-variant-revert";

async function withEuroMarket(chaos: ChaosContext) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  chaos.fake.addPriceList({
    id: EUR,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: null,
    catalog: { id: "gid://shopify/MarketCatalog/eu-variant-revert", title: "EU", __typename: "MarketCatalog" },
    prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [EUR] } as never },
  });
}

const euro = (chaos: ChaosContext, variantGid: string) => chaos.fake.priceOf(variantGid, EUR);
const base = (chaos: ChaosContext, variantGid: string) => Number(chaos.fake.priceOf(variantGid)!.replace(".", ""));
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: reverting one variant out of a sale with a market", () => {
  it("recomputes it on every surface the campaign writes, and says which", async () => {
    await withChaos("variant-revert-markets", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const [victim, ...others] = variantGids;
      await withEuroMarket(chaos);

      await chaos.expectHonest((await chaos.apply()).runId);
      for (const gid of variantGids) expect(euro(chaos, gid), "the sale never reached Europe").toBe("40.00");

      const result = await revertVariant(shopId, campaignId, victim, chaosAdminClient(chaos.server.endpoint()), {
        actor: "staff@example.com",
      });

      expect(base(chaos, victim)).toBe(baseline.get(victim));
      expect(euro(chaos, victim), "the variant stayed on sale in Europe").toBe("50.00");
      for (const gid of others) {
        expect(euro(chaos, gid), "a run over one variant moved another").toBe("40.00");
        expect(base(chaos, gid)).toBe(Math.round(baseline.get(gid)! * 0.8));
      }

      // A row per surface, in the revert's own ledger.
      const rows = await prisma.variantChange.findMany({
        where: { runId: result.outcome!.runId },
        select: { variantGid: true, priceListGid: true, status: true, verifiedPrice: true },
      });
      expect(rows.map((row) => [row.variantGid, row.priceListGid, row.status]).sort()).toEqual(
        [
          [victim, "", "VERIFIED"],
          [victim, EUR, "VERIFIED"],
        ].sort(),
      );

      expect(result.message).toContain("Recomputed without it and verified: the base price and Europe (EUR).");
      expect(result.message).not.toMatch(/Not confirmed/);
    });
  });

  it("takes the campaign's strike-through off the market too", async () => {
    // A compare-at the campaign set is part of the sale. Shopify keeps a list's compare-at
    // unless told to clear it, and a market write that only ever omitted it left the
    // variant at its normal price with the sale's strike-through beside it.
    await withChaos("variant-revert-market-compare-at", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await withEuroMarket(chaos);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { compareAtPolicy: { kind: "set-to-baseline" } as never },
      });

      await chaos.expectHonest((await chaos.apply()).runId);
      const struck = chaos.fake.fixedPricesOn(EUR).get(variantGids[0]);
      expect(struck, "the campaign set no strike-through, so this tests nothing").toEqual({
        amount: "40.00",
        compareAt: "50.00",
      });

      await revertVariant(shopId, campaignId, variantGids[0], chaosAdminClient(chaos.server.endpoint()));

      expect(chaos.fake.fixedPricesOn(EUR).get(variantGids[0]), "the sale's strike-through stayed").toEqual({
        amount: "50.00",
        compareAt: null,
      });
      expect(chaos.fake.fixedPricesOn(EUR).get(variantGids[1])).toEqual({ amount: "40.00", compareAt: "50.00" });
    });
  });

  it("says which market it could not write, and that the base price is done", async () => {
    await withChaos("variant-revert-market-fails", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await withEuroMarket(chaos);
      await chaos.expectHonest((await chaos.apply()).runId);

      chaos.arm([{ fault: "server-error", match: (query) => /priceListFixedPricesAdd|PriceListFixedPrices/i.test(query) }]);
      const result = await revertVariant(shopId, campaignId, variantGids[0], chaosAdminClient(chaos.server.endpoint()));
      chaos.heal();

      expect(result.message).toMatch(/verified: the base price\. Not confirmed: Europe \(EUR\)\..*Revert this variant again/);
    });
  });
});

describe("chaos: reverting one variant out of a markets-only sale applied with one percentage", () => {
  it("prices that variant alone, and leaves the market's percentage to the rest", async () => {
    // The market-wide shortcut moved the whole list's parent adjustment. A run over one
    // variant must never touch that: it would reprice every product in the market.
    const EU = "gid://shopify/PriceList/eu-wide-revert";
    await withChaos("variant-revert-market-wide", { catalog: { products: 12, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: EU,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/eu-wide-revert", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { base: false, priceLists: [EU] } as never },
      });
      const list = chaos.fake.priceLists.find((l) => l.id === EU)!;
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.derivedPriceOf(gid, list)!]));

      await chaos.expectHonest((await chaos.apply()).runId);
      const parentWrites = chaos.fake.parentWrites.length;
      expect(parentWrites, "the shortcut was not taken, so this tests nothing").toBeGreaterThan(0);
      const sale = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, EU)]));

      const [victim, ...others] = variantGids;
      await revertVariant(shopId, campaignId, victim, chaosAdminClient(chaos.server.endpoint()));

      expect(chaos.fake.parentWrites, "a run over one variant moved the whole market").toHaveLength(parentWrites);
      expect(chaos.fake.priceOf(victim, EU), "the variant stayed on sale in Europe").toBe(before.get(victim));
      for (const gid of others) expect(chaos.fake.priceOf(gid, EU)).toBe(sale.get(gid));
    });
  });
});

describe("chaos: a variant revert and a full run of the same campaign", () => {
  it("a full apply stands down while a variant change is being written, and gives its claim back", async () => {
    await withChaos("variant-revert-race-full", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      // A variant run already writing: its row exists, as it does from the moment it starts.
      await prisma.campaignRun.create({
        data: {
          shopId,
          campaignId,
          kind: "REVERT",
          status: "EXECUTING",
          occurrenceKey: `VARIANT-REVERT-${variantGids[0]}-${Date.now()}`,
          startedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });

      const outcome = await chaos.apply();
      expect(outcome.refused).toMatch(/one variant of this campaign is being written right now/);
      expect(outcome.deferredTo).toBeTruthy();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status, "the claim was kept").toBe(
        "DRAFT",
      );
      for (const gid of variantGids) expect(base(chaos, gid), "the full apply wrote anyway").toBe(baseline.get(gid));
    });
  });

  it("a variant revert stands down while a full apply holds the campaign", async () => {
    await withChaos("variant-revert-race-scoped", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      const sale = base(chaos, variantGids[0]);
      // A full apply has claimed it and is writing.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });

      const result = await revertVariant(shopId, campaignId, variantGids[0], chaosAdminClient(chaos.server.endpoint()));

      expect(result.message).toMatch(/being applied right now, so nothing was written for this variant/);
      expect(base(chaos, variantGids[0]), "the variant revert wrote during a full apply").toBe(sale);
      const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: result.outcome!.runId } });
      expect(run.status).toBe("CANCELLED");
      expect(await prisma.variantChange.count({ where: { runId: run.id } })).toBe(0);
      // The exclusion is durable either way; pressing it again once the apply finishes
      // recomputes the price.
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).excludedVariantGids).toContain(
        variantGids[0],
      );
    });
  });
});
