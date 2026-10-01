/**
 * A duplicate prices what its source prices (#762).
 *
 * The filter, segment, rounding and practice flag live in the `schedule` JSON beside the
 * dates, and Duplicate dropped the whole blob so last month's dates were not re-armed. The
 * copy got `{}`: an empty filter, which matches the whole catalogue. A merchant who
 * duplicated "Alpine clearance · 30% off Alpine boards" to run it again had a draft that
 * put every variant in the store at 30% off, and a practice campaign's copy could be
 * applied for real.
 *
 * Applied through the real run path; the catalogue has one variant the source does not
 * cover, so a copy that lost its scope plans one row too many.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { duplicateCampaign } from "../../app/services/campaigns/housekeeping.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const OUTSIDE = "gid://shopify/ProductVariant/outside-the-scope";

/** A variant in the store that the fixture campaign's tag filter does not cover. */
async function addVariantOutsideScope(chaos: ChaosContext) {
  const { shopId } = chaos.fixture;
  await prisma.variantIndex.create({
    data: {
      shopId,
      variantGid: OUTSIDE,
      productGid: "gid://shopify/Product/outside-the-scope",
      title: "Not on sale",
      price: 5000n,
      currency: "USD",
      status: "ACTIVE",
      tags: ["something-else"],
    },
  });
  await prisma.priceSurfaceEntry.create({
    data: { shopId, variantGid: OUTSIDE, surfaceKind: "BASE", priceListGid: "", currency: "USD", livePrice: 5000n },
  });
  await prisma.baseline.create({
    data: {
      shopId,
      variantGid: OUTSIDE,
      surfaceKind: "BASE",
      priceListGid: "",
      currency: "USD",
      basePrice: 5000n,
      source: "INSTALL_CAPTURE",
    },
  });
}

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 } as const;

describe("chaos: duplicating a campaign", () => {
  it("prices the same variants as its source, not the whole catalogue", async () => {
    await withChaos("duplicate-scope", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await addVariantOutsideScope(chaos);

      const copy = await duplicateCampaign(shopId, campaignId, "staff@example.com");
      const outcome = await runCampaign(shopId, copy.id, chaosAdminClient(chaos.server.endpoint()), {
        verifySampleRate: 1,
      });

      expect(outcome.planned, "the copy planned variants its source never covered").toBe(variantGids.length);
      const written = await prisma.variantChange.findMany({
        where: { runId: outcome.runId },
        select: { variantGid: true },
      });
      expect(written.map((row) => row.variantGid).sort()).toEqual([...variantGids].sort());
      expect(written.map((row) => row.variantGid)).not.toContain(OUTSIDE);
    });
  });

  it("keeps a practice campaign's copy a practice campaign", async () => {
    await withChaos("duplicate-practice", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const source = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { schedule: { ...(source.schedule as object), practice: true } as never },
      });

      const copy = await duplicateCampaign(shopId, campaignId, "staff@example.com");
      await expect(
        runCampaign(shopId, copy.id, chaosAdminClient(chaos.server.endpoint()), {}),
        "a practice campaign's copy was applied to the storefront",
      ).rejects.toThrow(/practice campaign/);
      expect(await prisma.campaignRun.count({ where: { campaignId: copy.id } })).toBe(0);
    });
  });
});
