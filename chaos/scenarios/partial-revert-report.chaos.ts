/**
 * After a revert stops part-way, its own restored prices are not "edited" (#910).
 *
 * The rollback report measured drift against the sale price the campaign's newest apply
 * wrote. A revert that stopped part-way has already put some prices back, and every one of
 * those read as "changed since … someone edited those on purpose": on boltify-apps the
 * header offered "Review 37 edited before reverting" in place of Resume revert, for 37
 * prices Anchor itself had restored. On a 100k revert that stopped half-way it would be
 * tens of thousands of false edits.
 *
 * A merchant's genuine edit after the partial revert must still be drift.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { withChaos } from "../harness/scenario";

const minor = (price: string | undefined) => (price === undefined ? undefined : Math.round(Number(price) * 100));

describe("chaos: the rollback report after a revert that stopped part-way", () => {
  it("counts the prices the revert put back as reverted, and a later hand edit as drift", async () => {
    await withChaos("partial-revert-report", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

      await chaos.expectHonest((await chaos.apply()).runId);

      // The revert's writes fail after the first two products.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("productVariantsBulkUpdate"), after: 2 }]);
      const revert = await chaos.revert();
      chaos.heal();
      expect(revert.clean, "the revert did not stop part-way").toBe(false);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");

      const restored = variantGids.filter((gid) => minor(chaos.fake.priceOf(gid)) === baseline.get(gid));
      expect(restored.length, "the revert restored nothing").toBeGreaterThan(0);
      expect(restored.length, "the revert restored everything").toBeLessThan(variantGids.length);

      const report = await rollbackReport(shopId, campaignId);
      expect(report.counts.drifted, "the revert's own restored prices read as edited").toBe(0);
      expect(report.straightforward, "the header would offer Review instead of Resume revert").toBe(true);
      for (const gid of restored) {
        expect(report.rows.find((row) => row.variantGid === gid)?.kind).toBe("clean");
      }

      // Now a real edit, to a price the revert had restored.
      const edited = restored[0];
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: edited, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: 1234n },
      });
      const after = await rollbackReport(shopId, campaignId);
      expect(after.counts.drifted).toBe(1);
      expect(after.rows.find((row) => row.variantGid === edited)?.kind, "a hand edit after the revert went unreported").toBe("drifted");
    });
  });
});
