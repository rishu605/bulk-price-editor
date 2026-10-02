/**
 * The rollback report says "changed since" only about a real edit (#777, #886).
 *
 * The report is a merchant's only view of what a revert will do, and two things made it
 * report edits nobody made:
 *
 *   #777 -- every campaign with a market. "We applied" was read from the newest ledger
 *   row of any surface, which is a market row, and compared with the *base* live price.
 *   Every variant read "changed since … someone edited those on purpose" seconds after a
 *   clean apply, and the plain Revert was replaced by "Review N edited before reverting".
 *
 *   #886 -- a variant taken out with "Revert this variant". Its live price is Anchor's own
 *   recompute, and it was compared with the sale price the campaign once wrote.
 *
 * Ticking "Leave as it is" on such a row keeps the campaign's price after the campaign
 * says prices are back -- the harm a lying report invites.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/eu-rollback-report";

async function withEuroMarket(chaos: ChaosContext) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  chaos.fake.addPriceList({
    id: EUR,
    name: "Europe",
    currency: "EUR",
    country: "DE",
    adjustment: null,
    catalog: { id: "gid://shopify/MarketCatalog/eu-rollback-report", title: "EU", __typename: "MarketCatalog" },
    prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [EUR] } as never },
  });
}

const CATALOG = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -35 } as const;

describe("chaos: the rollback report right after a clean apply", () => {
  it("says nothing changed for a campaign that also prices a market (#777)", async () => {
    await withChaos("rollback-report-market", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      await withEuroMarket(chaos);
      await chaos.expectHonest((await chaos.apply()).runId);
      // The market really was written, so its rows are newest in the ledger.
      const ledger = await prisma.variantChange.groupBy({ by: ["surfaceKind"], where: { shopId }, _count: true });
      expect(ledger.map((g) => g.surfaceKind).sort()).toEqual(["BASE", "MARKET"]);

      const report = await rollbackReport(shopId, campaignId);

      expect(report.counts.drifted, "a clean apply reported every variant as hand-edited").toBe(0);
      expect(report.straightforward, "the plain Revert was replaced by 'Review N edited'").toBe(true);
      for (const row of report.rows) {
        // "We applied" is the base price the campaign wrote, not the euro one.
        expect(row.applied).toBe(row.live);
      }
      expect(report.rows.map((row) => row.applied).sort()).toEqual(
        variantGids.map((gid) => (Math.round(baseline.get(gid)! * 0.65) / 100).toFixed(2)).sort(),
      );
    });
  });

  it("leaves out a variant reverted out of the campaign, and still reports a real edit (#886)", async () => {
    await withChaos("rollback-report-excluded", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [reverted, edited, ...rest] = variantGids;
      await chaos.expectHonest((await chaos.apply()).runId);

      await revertVariant(shopId, campaignId, reverted, chaosAdminClient(chaos.server.endpoint()));
      const afterRevert = await rollbackReport(shopId, campaignId);
      expect(afterRevert.counts.drifted, "Anchor's own revert reported as somebody's edit").toBe(0);
      expect(afterRevert.rows.map((row) => row.variantGid)).not.toContain(reverted);
      expect(afterRevert.straightforward).toBe(true);

      // The control: a price somebody really changed is still a question.
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: edited, surfaceKind: "BASE" },
        data: { livePrice: 1234n },
      });
      const afterEdit = await rollbackReport(shopId, campaignId);
      expect(afterEdit.counts.drifted).toBe(1);
      expect(afterEdit.rows.find((row) => row.kind === "drifted")?.variantGid).toBe(edited);
      expect(afterEdit.counts.total).toBe(1 + rest.length);
    });
  });
});
