/**
 * A late products webhook from earlier in the same second as our write (#985).
 *
 * A product with more than 250 variants in scope is written in several calls (#847 sync,
 * #985 bulk), and each call sends its own `products/update`. Shopify stamps `updated_at`
 * to the second, so calls a moment apart carry the same time, and deliveries are not
 * ordered. The handler skipped a delivery only when it was strictly older than the mirror,
 * so the first call's snapshot, arriving late, put a later call's variant back at its old
 * price in the mirror and was taken for a hand edit: the campaign was held over a price
 * nobody touched, and a revert planned from that mirror would find the variant already at
 * its baseline and leave the sale live.
 *
 * The other half has to keep holding: a merchant's edit in that same second is still drift
 * (#932).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

/**
 * A products webhook stamped `updatedAt`, describing one variant in detail and listing all
 * of the product's variants, so nothing is tombstoned for being left out.
 */
async function deliver(chaos: ChaosContext, variantGid: string, price: string, updatedAt: string) {
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Large product",
      status: "active",
      tags: "chaos",
      updated_at: updatedAt,
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: chaos.fixture.variantGids.map((gid) => ({ admin_graphql_api_id: gid })),
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

for (const path of ["sync", "bulk"] as const) {
  describe(`chaos: a ${path} run over one product in two writes, then a late delivery from the same second`, () => {
    it("skips the delivery from before our write, and still records the merchant's edit in that second", async () => {
      await withChaos(`webhook-same-second-${path}`, { catalog: { products: 1, variantsPerProduct: 300 }, percent: -30 }, async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

        const applied = await chaos.apply({ forcePath: path });
        await chaos.expectHonest(applied.runId);
        expect(applied.clean).toBe(true);

        // The product's last variant, on its second write. Its earlier call's snapshot shows
        // it at full price, stamped the second the mirror now holds for it.
        const variantGid = variantGids[variantGids.length - 1];
        if (path === "bulk") {
          expect(chaos.fake.bulkLines.map((line) => line.variantGids.length)).toEqual([250, 50]);
          expect(chaos.fake.bulkLines[1].variantGids).toContain(variantGid);
        } else {
          expect(chaos.fake.variantWriteSizes).toEqual([250, 50]);
        }
        const write = await prisma.variantChange.findFirstOrThrow({ where: { runId: applied.runId, variantGid } });
        const mirrored = await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid } });
        // Not vacuous: the mirror holds exactly that second, so "strictly older" cannot skip it.
        expect(write.remoteUpdatedAt).not.toBeNull();
        expect(mirrored.remoteUpdatedAt?.getTime()).toBe(write.remoteUpdatedAt!.getTime());
        expect(write.beforePrice).toBe(BigInt(baseline.get(variantGid)!));
        const sale = mirrored.price;
        expect(sale).toBe(write.intendedPrice);

        const stamp = write.remoteUpdatedAt!.toISOString();
        await deliver(chaos, variantGid, (baseline.get(variantGid)! / 100).toFixed(2), stamp);

        const after = await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid } });
        expect(after.price, "a snapshot from before our write put the old price back in the mirror").toBe(sale);
        const surface = await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid, surfaceKind: "BASE" } });
        expect(surface.livePrice).toBe(sale);
        expect(await prisma.driftEvent.count({ where: { shopId, variantGid } }), "our own write was taken for a hand edit").toBe(0);
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");

        // The merchant's edit in that same second, to a price of their own: still drift.
        chaos.fake.variants.get(variantGid)!.price = "1.23";
        await deliver(chaos, variantGid, "1.23", stamp);
        const drift = await prisma.driftEvent.findFirst({ where: { shopId, variantGid, resolution: "PENDING" } });
        expect(drift, "an edit in the same second as the write was dropped").not.toBeNull();
        expect(Number(drift!.observedPrice)).toBe(123);
        expect((await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid } })).price).toBe(123n);
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("HELD");
      });
    });
  });
}
