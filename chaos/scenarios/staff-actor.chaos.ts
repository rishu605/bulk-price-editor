/**
 * Drift decisions, a duplicate from the campaigns list and a new segment are credited to the
 * staff member, not the store (#726).
 *
 * Each wrote `session.shop` -- the store's domain -- as who did it, while the campaign page
 * wrote the staff member through `actorFor`. Through each page's own action, with a
 * session token naming staff user 42.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

const STAFF = "staff:42";
let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

async function post(route: string, path: string, fields: Record<string, string>) {
  const { action } = (await import(route)) as { action: (args: unknown) => Promise<unknown> };
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return action({ request: new Request(`https://example.invalid${path}`, { method: "POST", body }), params: {}, context: {} });
}

describe("chaos: who did it, on the pages that used to say the store", () => {
  it("records the staff member for drift decisions, a duplicate and a segment", async () => {
    await withChaos("staff-actor", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain };
      const since = new Date(Date.now() - 1000);

      // Drift: one kept as the new baseline, one ignored. Observed at the price the mirror
      // holds, which is what adopting keeps.
      const [adopt, ignore] = await Promise.all(
        variantGids.map(async (variantGid) => {
          const live = await prisma.priceSurfaceEntry.findFirstOrThrow({
            where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" },
          });
          return prisma.driftEvent.create({
            data: { shopId, variantGid, surfaceKind: "BASE", currency: "USD", observedPrice: live.livePrice, expectedPrice: 1n },
          });
        }),
      );
      await post("../../app/routes/app.prices.drift", "/app/prices/drift", { eventId: adopt.id, resolution: "adopt" });
      await post("../../app/routes/app.prices.drift", "/app/prices/drift", { eventId: ignore.id, resolution: "ignore" });
      const resolved = await prisma.driftEvent.findMany({ where: { id: { in: [adopt.id, ignore.id] } } });
      expect(resolved.map((event) => event.resolvedBy), "a drift decision was credited to the store").toEqual([STAFF, STAFF]);
      const adopted = await prisma.baseline.findFirst({
        where: { shopId, variantGid: variantGids[0], surfaceKind: "BASE", supersededAt: null },
        orderBy: { capturedAt: "desc" },
      });
      expect(adopted?.capturedBy, "the adopted baseline names the store").toBe(STAFF);

      // A duplicate from the campaigns list.
      await post("../../app/routes/app.campaigns._index", "/app/campaigns", { intent: "duplicate", campaignId }).catch(
        (thrown: unknown) => thrown,
      );
      const copy = await prisma.campaign.findFirstOrThrow({ where: { shopId, id: { not: campaignId } } });
      expect(copy.createdBy).toBe(STAFF);

      // A segment.
      await post("../../app/routes/app.settings.segments", "/app/settings/segments", {
        intent: "create",
        name: "chaos/staff-actor segment",
        kind: "DYNAMIC",
        vendor: "Chaos",
      });
      const segment = await prisma.segment.findFirstOrThrow({ where: { shopId, name: "chaos/staff-actor segment" } });
      expect(segment.createdBy).toBe(STAFF);

      // And nothing the four wrote to the activity log names the store.
      const entries = await prisma.auditLogEntry.findMany({ where: { shopId, createdAt: { gte: since } } });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter((entry) => entry.actor === domain).map((entry) => entry.action)).toEqual([]);
    });
  });
});
