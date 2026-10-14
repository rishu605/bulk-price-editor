/**
 * A price edited in Shopify right after a run is recorded, whatever Shopify's clock says (#932).
 *
 * The mirror was stamped with our read-back time. A products webhook's `updated_at` is on
 * Shopify's clock, to the second, and a delivery older than the mirror's stamp is skipped
 * as stale -- so an edit made within a second of the run, or more with any clock skew, was
 * dropped before drift ever saw it. On boltify-apps an edit a second after an apply never
 * held the campaign. The stamp is now Shopify's own `updatedAt` from the write.
 *
 * A delivery from before the write is still stale and still skipped (#828).
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

/** A products webhook for one variant, stamped `updatedAt` on the store's clock. */
async function deliver(chaos: ChaosContext, variantGid: string, price: string, updatedAt: string) {
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Edited product",
      status: "active",
      tags: "chaos",
      updated_at: updatedAt,
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

for (const path of ["sync", "bulk"] as const) {
  describe(`chaos: an edit right after a ${path} run, on a store whose clock runs behind ours`, () => {
    it("is recorded as drift, and a delivery from before the write is still skipped", async () => {
      await withChaos(`webhook-store-clock-${path}`, { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const [edited, untouched] = variantGids;
        chaos.fake.storeClockSkewMs = -3_000;

        const applied = await chaos.apply({ actor: "chaos", forcePath: path });
        await chaos.expectHonest(applied.runId);
        const stamped = await prisma.variantChange.findFirstOrThrow({ where: { runId: applied.runId, variantGid: edited } });
        expect(stamped.remoteUpdatedAt, "the write's own Shopify timestamp was not recorded").not.toBeNull();
        const salePrice = chaos.fake.priceOf(untouched)!;

        // A delivery from before the write: stale, skipped, the sale price stays in the mirror.
        const before = new Date(stamped.remoteUpdatedAt!.getTime() - 60_000).toISOString();
        await deliver(chaos, untouched, "99.99", before);
        const mirror = await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: untouched } });
        expect(((Number(mirror.price) / 100).toFixed(2)), "a delivery from before the write overwrote the mirror").toBe(salePrice);

        // The merchant's edit, a moment after the write on the store's clock.
        chaos.fake.variants.get(edited)!.price = "1.23";
        await deliver(chaos, edited, "1.23", chaos.fake.storeNow());
        const drift = await prisma.driftEvent.findFirst({ where: { shopId, variantGid: edited, resolution: "PENDING" } });
        expect(drift, "the edit was dropped as older than the mirror").not.toBeNull();
        expect(Number(drift!.observedPrice)).toBe(123);
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("HELD");
      });
    });
  });
}
