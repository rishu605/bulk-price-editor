/**
 * A segment can be edited, and an edit that reaches a running campaign asks first (#742).
 *
 * Each row offered only Delete -- blocked while a campaign used the segment -- so "fixing
 * the segment once", the reason segments exist, meant making a new one no campaign used.
 *
 * Through the segments page's own loader and action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

type Answer = {
  ok: boolean;
  message: string;
  saved?: boolean;
  confirm?: { campaigns: Array<{ name: string; status: string }>; before: number; after: number };
};

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

describe("chaos: editing a segment", () => {
  it("renames and refilters, asks before reaching a running campaign, and pins", async () => {
    await withChaos("segment-edit", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };

      // A dynamic segment matching nothing yet.
      const segment = await createSegment(shopId, {
        name: "Edit me",
        kind: "DYNAMIC",
        filterAst: { groups: [{ conditions: [{ field: "tag", value: "nothing-has-this" }] }] },
      });

      // The page opens it for editing from the row's link, with its filter read back.
      const { loader } = await import("../../app/routes/app.settings.segments");
      const page = (await loader({
        request: new Request(`https://example.invalid/app/settings/segments?edit=${segment.id}`),
        params: {},
        context: {},
      } as never)) as { editing: { id: string; conditions: Record<string, string> } | null };
      expect(page.editing?.id).toBe(segment.id);
      expect(page.editing?.conditions.tag).toBe("nothing-has-this");

      // Renamed and refiltered, with nobody using it: saved at once.
      const saved = await post({ intent: "update", segmentId: segment.id, name: "Chaos tagged", tag: "chaos" });
      expect(saved).toMatchObject({ ok: true, saved: true });
      const after = await prisma.segment.findUniqueOrThrow({ where: { id: segment.id } });
      expect(after.name).toBe("Chaos tagged");
      expect(JSON.stringify(after.filterAst)).toContain('"value":"chaos"');

      // Now a running campaign uses it: an edit asks first, with the sizes.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "ACTIVE", segments: { connect: { id: segment.id } } },
      });
      const asked = await post({ intent: "update", segmentId: segment.id, name: "Chaos tagged", tag: "nothing-has-this" });
      expect(asked.ok).toBe(false);
      expect(asked.confirm).toMatchObject({ before: variantGids.length, after: 0 });
      expect(asked.confirm?.campaigns.map((c) => c.status)).toEqual(["ACTIVE"]);
      expect(JSON.stringify((await prisma.segment.findUniqueOrThrow({ where: { id: segment.id } })).filterAst)).toContain(
        '"value":"chaos"',
      );

      // Confirmed: pinned to what the filter matches now, and frozen.
      const pinned = await post({ intent: "update", segmentId: segment.id, name: "Chaos pinned", tag: "chaos", pin: "1", acknowledged: "1" });
      expect(pinned).toMatchObject({ ok: true, saved: true });
      const frozen = await prisma.segment.findUniqueOrThrow({ where: { id: segment.id } });
      expect(frozen.kind).toBe("FROZEN");
      expect([...frozen.frozenVariantGids].sort()).toEqual([...variantGids].sort());

      // A frozen list is replaced by a pasted one.
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { sku: "EDIT-SKU-0" } });
      const replaced = await post({ intent: "update", segmentId: segment.id, name: "Chaos pinned", csv: "EDIT-SKU-0", acknowledged: "1" });
      expect(replaced).toMatchObject({ ok: true });
      expect((await prisma.segment.findUniqueOrThrow({ where: { id: segment.id } })).frozenVariantGids).toEqual([variantGids[0]]);
    });
  });
});
