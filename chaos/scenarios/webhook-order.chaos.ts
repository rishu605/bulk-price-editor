/**
 * Product webhooks arriving out of order (#730).
 *
 * The staleness guard was per variant but the tombstone step was per product, and a
 * tombstone carried no time. So a late `products/update` -- older than what the mirror
 * held, delivered after it -- revived a variant the merchant had deleted (its stored time
 * predated the delivery) and then tombstoned the live ones it skipped as stale. Mirror
 * `{D}`, truth `{A, B}`: live variants out of revert planning, left on sale. A late update
 * after `products/delete` revived a whole deleted product the same way.
 *
 * Driven through the route's own handler; only `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

async function deliver(shop: string, topic: string, payload: unknown) {
  pending = { shop, topic, payload, admin };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const update = (productGid: string, gids: string[], at: Date) => ({
  admin_graphql_api_id: productGid,
  title: "Ordered product",
  status: "active",
  updated_at: at.toISOString(),
  variants: gids.map((gid) => ({ admin_graphql_api_id: gid, title: "V", price: "10.00" })),
  variant_gids: gids.map((gid) => ({ admin_graphql_api_id: gid })),
});

const aliveOn = async (shopId: string, productGid: string) =>
  (
    await prisma.variantIndex.findMany({
      where: { shopId, productGid, deletedAt: null },
      select: { variantGid: true },
      orderBy: { variantGid: "asc" },
    })
  ).map((row) => row.variantGid);

describe("chaos: product webhooks out of order", () => {
  it("a late update neither revives a deleted variant nor tombstones the live ones", async () => {
    await withChaos("webhook-order", { catalog: { products: 1, variantsPerProduct: 3 } }, async (chaos) => {
      const { shopId, domain, variantGids, productOf } = chaos.fixture;
      const productGid = productOf.get(variantGids[0])!;
      const [a, b, d] = [...variantGids].sort();
      const t0 = new Date(Date.now() - 30 * 60_000);
      const t1 = new Date(t0.getTime() + 60_000);
      const t2 = new Date(t0.getTime() + 120_000);

      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b, d], t0));
      expect(await aliveOn(shopId, productGid)).toEqual([a, b, d]);

      // The merchant deletes D. The newer payload arrives first...
      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b], t2));
      expect(await aliveOn(shopId, productGid)).toEqual([a, b]);

      // ...and the one written before the deletion arrives after it.
      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b, d], t1));
      expect(await aliveOn(shopId, productGid), "the late delivery rewrote the mirror").toEqual([a, b]);
    });
  });

  it("a late update does not tombstone a variant added after it was written", async () => {
    await withChaos("webhook-order-added", { catalog: { products: 1, variantsPerProduct: 2 } }, async (chaos) => {
      const { shopId, domain, variantGids, productOf } = chaos.fixture;
      const productGid = productOf.get(variantGids[0])!;
      const [a, b] = [...variantGids].sort();
      const e = `gid://shopify/ProductVariant/added-${chaos.seed}`;
      const t0 = new Date(Date.now() - 30 * 60_000);

      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b], t0));
      // The merchant adds E. That payload arrives first...
      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b, e], new Date(t0.getTime() + 120_000)));
      // ...then one written before E existed, which does not list it.
      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, [a, b], new Date(t0.getTime() + 60_000)));

      expect(await aliveOn(shopId, productGid), "a stale list tombstoned a variant added since").toEqual([a, b, e].sort());
    });
  });

  it("a late update does not bring a deleted product back", async () => {
    await withChaos("webhook-order-delete", { catalog: { products: 1, variantsPerProduct: 2 } }, async (chaos) => {
      const { shopId, domain, variantGids, productOf } = chaos.fixture;
      const productGid = productOf.get(variantGids[0])!;

      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, variantGids, new Date(Date.now() - 10 * 60_000)));
      await deliver(domain, "PRODUCTS_DELETE", { admin_graphql_api_id: productGid });
      expect(await aliveOn(shopId, productGid)).toEqual([]);

      // Written a minute before the deletion, delivered after it.
      await deliver(domain, "PRODUCTS_UPDATE", update(productGid, variantGids, new Date(Date.now() - 60_000)));
      expect(await aliveOn(shopId, productGid), "a late update revived a deleted product").toEqual([]);
    });
  });
});
