/**
 * Shopify refuses the app bulk mutations altogether (#1188).
 *
 * From 12 Nov 2026 a public app without an IP allowlist may not start a bulk operation,
 * and an app that has started none for 31 days must have them enabled again. Shopify then
 * answers `bulkOperationRunMutation` with "Access denied for bulkOperationRunMutation
 * field" and runs nothing. On production every apply over 1,000 prices went Partial with
 * "Your session expired" and wrote nothing, applied by hand or scheduled. The prices are
 * as writable as ever one call per product, so the run writes them that way.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { selectWritePath } from "../../app/lib/planning/write-path";
import { withChaos } from "../harness/scenario";

/** A Plus store's bucket, so 1,200 prices one call per product take seconds, not minutes. */
const PLUS = { maximumAvailable: 20_000, currentlyAvailable: 20_000, restoreRate: 1_000 };

describe("chaos: Shopify denies the app bulk mutations", () => {
  it("writes a bulk-sized apply one call per product instead, ends verified-clean, and records the path it took", async () => {
    await withChaos(
      "bulk-denied",
      { catalog: { products: 6, variantsPerProduct: 200 }, percent: -10, throttle: PLUS },
      async (chaos) => {
        const { variantGids, baseline, campaignId } = chaos.fixture;
        expect(selectWritePath(variantGids.length).path).toBe("bulk");
        chaos.fake.bulkMutationsDenied = true;
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Nothing went in bulk; every price went one call per product, none over 250.
        expect(chaos.fake.bulkLines).toEqual([]);
        expect(chaos.fake.variantWriteSizes.reduce((sum, size) => sum + size, 0)).toBe(variantGids.length);
        expect(Math.max(...chaos.fake.variantWriteSizes)).toBeLessThanOrEqual(250);

        expect(applied.verified).toBe(variantGids.length);
        expect(applied.failed).toBe(0);
        expect(applied.unverified).toBe(0);
        expect(applied.clean).toBe(true);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
        // The path it took, which the next run's estimate of its time reads (#1055).
        const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: applied.runId }, select: { writePath: true } });
        expect(run.writePath).toBe("SYNC");
      },
    );
  });

  it("reverts the same way, back to every baseline", async () => {
    await withChaos(
      "bulk-denied-revert",
      { catalog: { products: 6, variantsPerProduct: 200 }, percent: -10, throttle: PLUS },
      async (chaos) => {
        const { variantGids, baseline } = chaos.fixture;
        chaos.fake.bulkMutationsDenied = true;

        const applied = await chaos.apply();
        expect(applied.clean).toBe(true);
        const reverted = await chaos.revert();
        await chaos.expectHonest(reverted.runId);

        expect(chaos.fake.bulkLines).toEqual([]);
        expect(reverted.clean).toBe(true);
        expect(reverted.failed).toBe(0);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
      },
    );
  });
});
