/**
 * A reaper sweep scoped to one shop leaves every other shop's runs alone (#1069).
 *
 * Two scenarios swept the whole database with a staleness short enough, or a clock far
 * enough ahead, that any run in flight elsewhere read as dead. Several chaos runs share one
 * Postgres, so they reclaimed each other's live campaigns -- Partial mid-run -- and then failed
 * on runs that were not theirs, which reads exactly like the #791 regression they exist for.
 *
 * Through the real `reclaimStaleRuns`, with a second shop's quiet run beside the fixture's.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { reclaimStaleRuns } from "../../app/services/campaigns/reaper.server";
import { withChaos } from "../harness/scenario";

describe("chaos: a scoped reaper sweep", () => {
  it("reclaims its own shop's quiet run and leaves another shop's, though it is as quiet", async () => {
    await withChaos("reaper-scope", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const longAgo = new Date(Date.now() - 60 * 60_000);
      const later = new Date(Date.now() + 60 * 60_000);

      const other = await prisma.shop.create({ data: { domain: `reaper-scope-other-${Date.now()}.myshopify.com` } });
      try {
        const otherCampaign = await prisma.campaign.create({
          data: { shopId: other.id, name: "Another shop's sale", status: "APPLYING", ruleRows: [] as never, schedule: { kind: "manual" } as never },
        });
        const quiet = { kind: "APPLY" as const, status: "EXECUTING" as const, startedAt: longAgo, heartbeatAt: longAgo };
        const theirs = await prisma.campaignRun.create({ data: { ...quiet, shopId: other.id, campaignId: otherCampaign.id, occurrenceKey: "APPLY-theirs" } });
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });
        const ours = await prisma.campaignRun.create({ data: { ...quiet, shopId, campaignId, occurrenceKey: "APPLY-ours" } });

        expect((await reclaimStaleRuns(later, 60_000, { shopId })).runIds).toEqual([ours.id]);
        expect((await prisma.campaignRun.findUniqueOrThrow({ where: { id: theirs.id } })).status, "another shop's run was reclaimed").toBe("EXECUTING");
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: otherCampaign.id } })).status).toBe("APPLYING");

        // Stale all the same: swept as its own shop, it is reclaimed. The scope alone kept it.
        // (Not an unscoped sweep here: an hour ahead, that would reclaim every other
        // scenario's run on the database, which is the bug.)
        expect((await reclaimStaleRuns(later, 60_000, { shopId: other.id })).runIds).toEqual([theirs.id]);
      } finally {
        await prisma.shop.delete({ where: { id: other.id } });
      }
    });
  });
});
