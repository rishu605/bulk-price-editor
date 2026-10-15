/**
 * "Keep the change" keeps what the old baseline knew besides its price (#1013).
 *
 * Adopting a drifted price made a baseline with only `basePrice`: the old compare-at and
 * cost were dropped, so a later campaign's compare-at policy found none and an imported
 * cost (#737) was gone. The single and the bulk keep (#822) both did it.
 *
 * Through the real `resolveDrift` and `decideDrift`.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { resolveDrift } from "../../app/services/drift.server";
import { decideDrift } from "../../app/services/drift-queue.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

/** A merchant's edit to `variantGid`, mirrored and held as drift. */
async function edited(chaos: ChaosContext, variantGid: string, cents: number) {
  const { shopId, campaignId } = chaos.fixture;
  chaos.fake.variants.get(variantGid)!.price = (cents / 100).toFixed(2);
  await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid, surfaceKind: "BASE" }, data: { livePrice: BigInt(cents) } });
  return prisma.driftEvent.create({
    data: { shopId, variantGid, surfaceKind: "BASE", campaignId, observedPrice: BigInt(cents), expectedPrice: 1n, currency: "USD" },
  });
}

const current = (shopId: string, variantGid: string) =>
  prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid, surfaceKind: "BASE", supersededAt: null } });

describe("chaos: keeping a drifted price", () => {
  it("carries the old baseline's compare-at, and Shopify's cost where it has one, single and bulk", async () => {
    await withChaos("adopt-keeps-fields", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [single, bulk] = variantGids;
      await chaos.expectHonest((await chaos.apply()).runId);

      // What the old baselines knew: a compare-at, and an imported cost.
      await prisma.baseline.updateMany({ where: { shopId, supersededAt: null }, data: { baseCompareAt: 9_999n, cost: 500n } });
      // Shopify holds a cost for one variant and none for the other.
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: single }, data: { cost: 600n } });
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: bulk }, data: { cost: null } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "HELD" } });

      // One kept on its own...
      const event = await edited(chaos, single, 4_200);
      await resolveDrift(shopId, event.id, "adopt", "staff:1");
      const kept = await current(shopId, single);
      expect(kept.basePrice).toBe(4_200n);
      expect(kept.baseCompareAt, "the single keep dropped the compare-at").toBe(9_999n);
      expect(kept.cost, "Shopify's cost, where it has one").toBe(600n);

      // ...and one in a bulk decision.
      await edited(chaos, bulk, 4_300);
      await decideDrift(
        shopId,
        { campaignId, resolution: "adopt", asOf: new Date(Date.now() + 60_000).toISOString() },
        "staff:1",
        chaosAdminClient(chaos.server.endpoint()),
      );
      const bulkKept = await current(shopId, bulk);
      expect(bulkKept.basePrice).toBe(4_300n);
      expect(bulkKept.baseCompareAt, "the bulk keep dropped the compare-at").toBe(9_999n);
      expect(bulkKept.cost, "the old baseline's cost, where Shopify has none").toBe(500n);
    });
  });
});
