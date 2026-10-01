/**
 * A price changed outside the app while no campaign was running (#745).
 *
 * Off baseline is what a sale looks like -- but only when a campaign put the price there.
 * What's live called every off-baseline cell "what a running campaign looks like", so a
 * price the merchant changed while nothing was running sat behind a green banner. Its
 * baseline stays the old price (nothing updates a baseline outside a campaign), so the
 * next sale discounts from the old price and ending it puts the old price back.
 *
 * Driven against a real database: one variant a campaign has priced, one the merchant
 * changed with nothing running, one untouched.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { reconcile, staleBaselineCount, uncontrolledAmong } from "../../app/services/reconciliation.server";
import { planRecapture } from "../../app/services/recapture.server";
import { withChaos } from "../harness/scenario";

describe("chaos: a price changed outside any campaign", () => {
  it("is counted as a stale baseline, not as a running campaign, and recapture can scope to it", async () => {
    await withChaos("stale-baseline", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      const [onSale, changedByHand, untouched] = variantGids;

      // A campaign over the first variant only, applied for real.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { excludedVariantGids: [changedByHand, untouched] },
      });
      const applied = await chaos.apply();
      expect(applied.verified).toBe(1);

      // The merchant changes the second one in the Shopify admin, with nothing running on it.
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: changedByHand, surfaceKind: "BASE" },
        data: { livePrice: BigInt(baseline.get(changedByHand)! + 1_000) },
      });

      const { counts } = await reconcile(shopId, domain, {});
      expect(counts.offBaseline).toBe(2);
      expect(counts.staleBaseline, "a hand-changed price was called a running campaign").toBe(1);
      expect(await staleBaselineCount(shopId)).toBe(1);
      // What the previews ask: of the rows they found off baseline, how many no running
      // campaign wrote. The one on sale is the campaign's; the hand-changed one is not.
      expect(await uncontrolledAmong(shopId, [onSale, changedByHand])).toBe(1);
      expect(await uncontrolledAmong(shopId, [onSale])).toBe(0);
      expect(await uncontrolledAmong(shopId, [])).toBe(0);
      void untouched;

      // The filter lists exactly that one.
      const listed = await reconcile(shopId, domain, { staleBaselineOnly: true });
      expect(listed.rows.map((row) => row.variantGid)).toEqual([changedByHand]);

      // And a recapture scoped to stale baselines would rewrite only that variant.
      const plan = await planRecapture(shopId, { stale: true });
      expect(plan.variantGids).toEqual([changedByHand]);

    });
  });
});
