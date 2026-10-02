/**
 * A run's mirror is current before the run, or its campaign, says it has finished (#906).
 *
 * The mirror was refreshed row by row -- two queries a variant -- after the campaign was
 * moved to Active. On anchor-perf's 102,132-variant apply that took minutes: the campaign
 * read Active at 05:20:19, a revert pressed 27 seconds later planned against a mirror still
 * holding pre-run prices, skipped 3,831 variants as "already at baseline", and reported
 * clean. Forty sampled were still 10% off in Shopify. The late refresh then overwrote 2,514
 * rows the revert had just restored.
 *
 * Checked at the two moments that matter: as the run row is marked finished, and as the
 * campaign is moved to Active -- each a write the spy sees before it lands. Then the
 * merchant reverts straight away.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

afterEach(() => vi.restoreAllMocks());

describe("chaos: revert straight after a large apply", () => {
  it("finds the mirror current the moment the apply says it is done, and ends every price at baseline", async () => {
    await withChaos("mirror-before-done", { catalog: { products: 20, variantsPerProduct: 2 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const sale = (gid: string) => BigInt(Math.round(baseline.get(gid)! * 0.9));

      /** Base mirror rows not yet showing the price the apply wrote. */
      const stale = async () => {
        const rows = await prisma.priceSurfaceEntry.findMany({ where: { shopId, surfaceKind: "BASE" }, select: { variantGid: true, livePrice: true } });
        return rows.filter((row) => row.livePrice !== sale(row.variantGid)).length;
      };

      const seen: Record<string, number> = {};
      const runUpdate = prisma.campaignRun.update.bind(prisma.campaignRun);
      vi.spyOn(prisma.campaignRun, "update").mockImplementation((async (args: { data?: { status?: string } }) => {
        if (args.data?.status === "COMPLETED") seen.runFinished = await stale();
        return runUpdate(args as never);
      }) as never);
      const campaignUpdate = prisma.campaign.updateMany.bind(prisma.campaign);
      vi.spyOn(prisma.campaign, "updateMany").mockImplementation((async (args: { data?: { status?: string } }) => {
        if (args.data?.status === "ACTIVE") seen.campaignActive = await stale();
        return campaignUpdate(args as never);
      }) as never);

      await chaos.expectHonest((await chaos.apply()).runId);
      vi.restoreAllMocks();

      expect(seen.runFinished, "the run said it was finished over a stale mirror").toBe(0);
      expect(seen.campaignActive, "the campaign read Active over a stale mirror").toBe(0);

      // The merchant reverts at once: everything the apply wrote is planned and written back.
      const reverted = await chaos.revert();
      expect(reverted.verified, "the revert skipped variants it believed were already at baseline").toBe(variantGids.length);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });
});
