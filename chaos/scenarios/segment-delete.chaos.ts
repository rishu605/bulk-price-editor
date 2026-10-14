/**
 * A segment only finished or draft campaigns used can be deleted, and those campaigns then
 * price nothing rather than everything (#776).
 *
 * Every campaign that had ever used a segment blocked its deletion with "remove from
 * campaigns first", which nothing in the app can do, so each spreadsheet import left a
 * permanent segment behind. And had the guard simply been lifted, a spreadsheet
 * campaign's own stored filter -- `{ groups: [] }` -- would have taken over as its scope:
 * the whole catalogue, one Apply away.
 *
 * Through the segments page's own action; then the real list, scope and run.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { DELETED_SEGMENT_SCOPE, scopeOf } from "../../app/services/campaigns/model.server";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { astToWhere } from "../../app/services/segments.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

type Answer = { ok: boolean; message: string; confirmDelete?: { segmentId: string; campaigns: Array<{ name: string }> } };

async function post(fields: Record<string, string>): Promise<Answer> {
  const { action } = await import("../../app/routes/app.settings.segments");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/settings/segments", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Answer;
}

describe("chaos: deleting a segment campaigns have used", () => {
  it("is refused while a live campaign uses it, and asks, then prices nothing, once only a finished one does", async () => {
    await withChaos("segment-delete", { catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };

      // A spreadsheet campaign's shape: a frozen segment, and an empty stored filter that
      // on its own would match every variant.
      const segment = await createSegment(shopId, { name: "Sale (imported)", kind: "FROZEN", variantGids: variantGids.slice(0, 2) });
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: "ACTIVE",
          schedule: { ...(campaign.schedule as object), ast: { groups: [] }, segmentId: segment.id } as never,
          segments: { connect: { id: segment.id } },
        },
      });

      // Live: refused, naming the campaign and a step that exists.
      const live = await post({ intent: "delete", segmentId: segment.id });
      expect(live.ok).toBe(false);
      expect(live.message).toContain(`"${campaign.name}": revert it first`);
      expect(live.message).not.toMatch(/remove from/i);
      expect(await prisma.segment.count({ where: { id: segment.id } })).toBe(1);

      // Finished: asked first, naming it; nothing deleted yet.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETED" } });
      const asked = await post({ intent: "delete", segmentId: segment.id });
      expect(asked.ok).toBe(false);
      expect(asked.confirmDelete?.segmentId).toBe(segment.id);
      expect(asked.confirmDelete?.campaigns.map((c) => c.name)).toEqual([campaign.name]);
      expect(await prisma.segment.count({ where: { id: segment.id } }), "deleted without asking").toBe(1);

      // Confirmed: gone.
      const deleted = await post({ intent: "delete", segmentId: segment.id, acknowledged: "1" });
      expect(deleted).toMatchObject({ ok: true });
      expect(await prisma.segment.count({ where: { id: segment.id } })).toBe(0);

      // The campaign now matches nothing -- not the whole catalogue its stored filter would.
      const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const inScope = await prisma.variantIndex.count({ where: astToWhere(shopId, await scopeOf(shopId, after)) });
      expect(inScope, "a deleted segment's campaign fell back to its stored filter").toBe(0);

      // It says so where it is listed.
      const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams("status=all")));
      expect(campaigns.find((c) => c.id === campaignId)?.scope).toBe(DELETED_SEGMENT_SCOPE);

      // And an Apply -- of it, or of a draft in its place -- is refused by name, writing nothing.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
      const before = variantGids.map((gid) => chaos.fake.priceOf(gid));
      await expect(chaos.apply()).rejects.toThrow(/segment was deleted/);
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(before);
      expect(await prisma.variantChange.count({ where: { run: { campaignId } } })).toBe(0);
    });
  });
});
