/**
 * A bulk operation that ends FAILED part-way, then Resume (#699).
 *
 * Rows missing from the result file are left unverified -- the ledger says APPLIED and
 * the run is PARTIAL, which is honest. But the mirror was updated as if they had landed:
 * `refreshMirror` recorded the intended price for every row that had not outright failed.
 * Resume then read the mirror, found live == intended, called every unwritten row
 * "already correct", wrote nothing and moved the campaign to ACTIVE. The storefront kept
 * the old price wherever the failed operation never reached, with no row read back.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { DEFAULT_THRESHOLD } from "../../app/lib/planning/write-path";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a bulk operation that fails part-way, then Resume", () => {
  it("leaves unverified rows unknown in the mirror, and Resume writes and verifies them", async () => {
    await withChaos(
      "bulk-failed-resume",
      { catalog: { products: 340, variantsPerProduct: 3 }, percent: -10, pollsBeforeComplete: 1 },
      async (chaos) => {
        const { shopId, variantGids, baseline, campaignId } = chaos.fixture;
        expect(variantGids.length).toBeGreaterThan(DEFAULT_THRESHOLD);
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        // One JSONL line per product: 310 applied, the last 30 products never reached.
        chaos.fake.bulkFailsAfterLines = 310;

        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);
        expect(first.clean).toBe(false);

        const unverified = (await ledgerOf(first.runId)).filter((row) => row.status === "APPLIED");
        expect(unverified).toHaveLength(30 * 3);

        // Never written, so still at full price in the store...
        for (const row of unverified) {
          expect(chaos.fake.priceOf(row.variantGid)).toBe((baseline.get(row.variantGid)! / 100).toFixed(2));
        }
        // ...and the mirror must not claim otherwise.
        const mirrored = await prisma.priceSurfaceEntry.findMany({
          where: {
            shopId,
            surfaceKind: "BASE",
            variantGid: { in: unverified.map((row) => row.variantGid) },
          },
          select: { livePrice: true },
        });
        expect(
          mirrored.every((entry) => entry.livePrice === null),
          "the mirror records a sale price nobody read back",
        ).toBe(true);

        // ------------------------------------------------------------ resume
        const resumed = await chaos.apply({ resume: true });
        await chaos.expectHonest(resumed.runId);

        expect(resumed.planned, "Resume called unwritten rows already correct").toBe(30 * 3);
        expect(resumed.clean).toBe(true);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect(campaign.status).toBe("ACTIVE");
      },
    );
  });
});
