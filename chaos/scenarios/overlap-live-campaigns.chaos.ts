/**
 * Overlap counts every campaign meant to be pricing its variants, not only Active ones (#821).
 *
 * On anchor-perf, *QA · perf* (priority 100, 10% off) was Held by one hand edit. A
 * priority-50 sale over 57 of its variants previewed with no mention of it, applied 30% off
 * over it, and its revert dialog said "No other campaign covers these variants" before
 * writing baselines under the campaign that still claimed them.
 *
 * Driven through `previewCampaign` and `runCampaign` against the fake store. The held
 * campaign is the fixture's own; the sale under it is created here.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const dollars = (minor: number) => (minor / 100).toFixed(2);

async function saleUnder(chaos: ChaosContext) {
  const { shopId } = chaos.fixture;
  return createCampaign(shopId, {
    name: "chaos/lower-sale",
    priority: 50,
    rule: { kind: "percent-change", percent: -30 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
    schedule: { kind: "manual" },
  } as never);
}

describe("chaos: a sale under a campaign that is held, not merely Active", () => {
  it("names the held campaign, writes nothing over it, leaves its hand edit alone, and reverts to its price", async () => {
    await withChaos("overlap-held", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: held, variantGids, productOf, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const sale = (gid: string) => dollars(Math.round(baseline.get(gid)! * 0.9));
      await prisma.campaign.update({ where: { id: held }, data: { priority: 100 } });

      await chaos.expectHonest((await chaos.apply()).runId);

      // The merchant edits one price by hand; the campaign is held while they decide.
      const edited = variantGids[0];
      const handPrice = Math.round(baseline.get(edited)! * 0.95);
      chaos.fake.addVariant({ variantGid: edited, productGid: productOf.get(edited)!, price: dollars(handPrice), compareAtPrice: null });
      await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: edited, surfaceKind: "BASE" }, data: { livePrice: BigInt(handPrice) } });
      await prisma.driftEvent.create({
        data: {
          shopId,
          variantGid: edited,
          surfaceKind: "BASE",
          priceListGid: "",
          campaignId: held,
          observedPrice: BigInt(handPrice),
          expectedPrice: BigInt(Math.round(baseline.get(edited)! * 0.9)),
          currency: "USD",
          resolution: "PENDING",
        },
      });
      await prisma.campaign.update({ where: { id: held }, data: { status: "HELD" } });

      // A priority-50 sale over the same variants.
      const lower = await saleUnder(chaos);
      const preview = await previewCampaign(shopId, lower.id, { client });
      expect(preview.overlaps, "the preview did not mention the held campaign").toEqual([
        expect.objectContaining({ campaignId: held, status: "HELD", keeps: variantGids.length, yields: 0 }),
      ]);
      expect(preview.counts.planned, "the preview planned writes over the held campaign").toBe(0);

      const applied = await runCampaign(shopId, lower.id, client, { verifySampleRate: 1 });
      expect(applied.planned, "the lower sale wrote over the held one").toBe(0);
      for (const gid of variantGids.slice(1)) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
      expect(chaos.fake.priceOf(edited), "the merchant's hand edit was overwritten").toBe(dollars(handPrice));

      // The revert dialog names who keeps them, and the revert writes nothing under it.
      const revertPreview = await previewCampaign(shopId, lower.id, { client, revert: true });
      expect(revertPreview.overlaps).toEqual([expect.objectContaining({ campaignId: held, keeps: variantGids.length })]);
      await runCampaign(shopId, lower.id, client, { revert: true, verifySampleRate: 1 });
      for (const gid of variantGids.slice(1)) expect(chaos.fake.priceOf(gid), "the revert wrote a baseline under the held campaign").toBe(sale(gid));
      expect(chaos.fake.priceOf(edited)).toBe(dollars(handPrice));
    });
  });

  it("does not let a campaign being ended win anything: its revert's work is not undone by the sale under it", async () => {
    await withChaos("overlap-ending", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: ending, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await prisma.campaign.update({ where: { id: ending }, data: { priority: 100 } });

      await chaos.expectHonest((await chaos.apply()).runId);
      // Its revert stopped part-way: Partial, with a revert as its latest whole-campaign run.
      await prisma.campaignRun.create({
        data: { shopId, campaignId: ending, kind: "REVERT", status: "PARTIAL", occurrenceKey: `REVERT-${Date.now()}` },
      });
      await prisma.campaign.update({ where: { id: ending }, data: { status: "PARTIAL" } });

      const lower = await saleUnder(chaos);
      const preview = await previewCampaign(shopId, lower.id, { client });
      expect(preview.overlaps ?? [], "a campaign being ended was offered as the winner").toEqual([]);

      // The sale under it prices the variants, and its own revert returns them to baseline --
      // not to the ending campaign's sale.
      await runCampaign(shopId, lower.id, client, { verifySampleRate: 1 });
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(Math.round(baseline.get(gid)! * 0.7)));
      await runCampaign(shopId, lower.id, client, { revert: true, verifySampleRate: 1 });
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "a revert put back a sale being ended").toBe(dollars(baseline.get(gid)!));
    });
  });
});
