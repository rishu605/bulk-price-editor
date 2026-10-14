/**
 * A merchant's edit kept by "leave the merchant's edit" is not drift, and its baseline shows
 * as changed outside a campaign (#1003).
 *
 * The exclude-only revert lets a variant go without writing anything. What's live still
 * compared the kept price with the campaign's old write -- "not what we wrote", counted in
 * the drift badge -- and the "changed outside a campaign" count ignored the exclusion, so
 * the variant's out-of-date baseline was never flagged and the next sale discounted from it.
 *
 * Through the real apply, the real exclude-only revert and What's live's own service.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { reconciliationFiltersFrom } from "../../app/lib/reporting/export-filters";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { reconcile } from "../../app/services/reconciliation.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: a merchant's edit the campaign was told to leave", () => {
  it("is not drift, and its baseline shows as changed outside a campaign", async () => {
    await withChaos("excluded-not-drifted", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      const [edited, untouched] = variantGids;
      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);

      // The merchant sets their own price in Shopify, and the mirror sees it.
      chaos.fake.variants.get(edited)!.price = "1.23";
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: edited, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: 123n },
      });
      const live = (gid: string) => reconcile(shopId, domain, reconciliationFiltersFrom(new URLSearchParams({ q: gid })), 1, 100);

      // Before: drift, rightly -- the campaign still claims that price.
      const before = await live(edited);
      expect(before.rows[0]?.drifted, "the premise: an edit under a live campaign is drift").toBe(true);
      expect(before.counts.drifted).toBe(1);

      // "Leave the merchant's edit": the campaign lets it go, writing nothing.
      await revertVariant(shopId, campaignId, edited, chaosAdminClient(chaos.server.endpoint()), { actor: "chaos", excludeOnly: true });
      expect(chaos.fake.priceOf(edited), "an exclusion moved a price").toBe("1.23");

      const after = await live(edited);
      expect(after.rows[0]?.drifted, "the kept edit still read as drift").toBe(false);
      expect(after.counts.drifted, "the badge still counted it").toBe(0);
      expect(after.counts.staleBaseline, "its out-of-date baseline was not flagged").toBe(1);

      // The variant still in the sale is neither.
      const still = await live(untouched);
      expect(still.rows[0]?.drifted).toBe(false);
      expect(still.rows[0]?.campaignId).toBe(campaignId);
    });
  });
});
