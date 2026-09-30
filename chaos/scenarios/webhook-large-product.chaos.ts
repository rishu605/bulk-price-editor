/**
 * `products/update` for a product with more than 100 variants (#729).
 *
 * Product webhooks describe the first 100 variants in `variants` and list every variant's
 * id in `variant_gids`. The handler read `variants` as the whole list and tombstoned the
 * rest -- variant 101 onward, on every update to a large product. A campaign's revert then
 * skipped them as deleted and left them on sale, and nothing looked at them again.
 *
 * Driven through the route's own handler; only `authenticate.webhook` is replaced, with
 * payloads shaped the way Shopify sends them.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

/** Answers the one question the route may ask a real admin: not a gift card. */
const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

async function deliver(shop: string, payload: unknown) {
  pending = { shop, topic: "PRODUCTS_UPDATE", payload, admin };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

/** As Shopify sends it: details for the first 100, ids for all of them. */
function update(productGid: string, gids: string[], options: { withGids?: boolean; price?: string } = {}) {
  return {
    admin_graphql_api_id: productGid,
    title: "A very large product",
    status: "active",
    vendor: "Acme",
    tags: "chaos",
    updated_at: new Date(Date.now() + 60_000).toISOString(),
    variants: gids.slice(0, 100).map((gid) => ({ admin_graphql_api_id: gid, title: "V", price: options.price ?? "10.00" })),
    ...(options.withGids === false ? {} : { variant_gids: gids.map((gid) => ({ admin_graphql_api_id: gid })) }),
  };
}

const alive = (shopId: string, productGid: string) =>
  prisma.variantIndex.count({ where: { shopId, productGid, deletedAt: null } });

describe("chaos: a product webhook for more than 100 variants", () => {
  it("keeps variants 101 onward, and still tombstones one that was really removed", async () => {
    await withChaos("webhook-large-product", { catalog: { products: 1, variantsPerProduct: 150 } }, async (chaos) => {
      const { shopId, domain, variantGids, productOf } = chaos.fixture;
      const productGid = productOf.get(variantGids[0])!;
      expect(await alive(shopId, productGid)).toBe(150);

      // An ordinary update -- an order, a stock change, Anchor's own write.
      await deliver(domain, update(productGid, variantGids));
      expect(await alive(shopId, productGid), "variants past the first 100 were tombstoned").toBe(150);

      // The same payload without `variant_gids` cannot say what is past 100, so nothing is
      // tombstoned on its word.
      await deliver(domain, update(productGid, variantGids, { withGids: false }));
      expect(await alive(shopId, productGid)).toBe(150);

      // The merchant deletes variant 140. It is gone from `variant_gids`; the first 100
      // are described as before.
      const removed = variantGids[139];
      await deliver(domain, update(productGid, variantGids.filter((gid) => gid !== removed)));
      expect(await alive(shopId, productGid)).toBe(149);
      const tombstoned = await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: removed } });
      expect(tombstoned.deletedAt).not.toBeNull();
    });
  });
});
