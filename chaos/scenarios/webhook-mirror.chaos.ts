/**
 * Keeping the mirror current between full syncs.
 *
 * Webhooks are how the mirror stays right, and the interesting cases are the ones where
 * a straightforward consumer quietly leaves it wrong:
 *
 *   A variant removed from a product. `products/update` carries the product's full
 *   variant list, so anything missing has been deleted — and a consumer that only
 *   upserts what it is given keeps the removed one alive forever. A campaign then
 *   enrolls a variant that does not exist, every write for it fails, and the run
 *   reports failures nobody can act on (E4).
 *
 *   An out-of-order delivery. Webhooks are not ordered, and applying the last one
 *   received rather than the newest one written means a stale payload can undo a fresh
 *   edit — leaving the mirror confidently wrong about a price.
 *
 * Driven through the route's own handler rather than a copy of its logic, so what is
 * tested is what Shopify actually calls.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/**
 * What the next delivery should authenticate as.
 *
 * Mutable module state rather than a closure, because the mock is bound once when the
 * route is first imported. Capturing the arguments per call meant every delivery after
 * the first authenticated as the *first* test's shop — which by then had been torn
 * down, so the handler no-opped and the assertion failed against a product bug that was
 * not there.
 */
let pending: { shop: string; topic: string; payload: unknown } = {
  shop: "",
  topic: "",
  payload: {},
};

// Hoisted, so the route sees it however it is imported. The route reads
// `authenticate.webhook`, which needs an HMAC we cannot produce here; mocking just that
// boundary keeps the whole consumer — diffing, tombstoning, drift, enrollment — under
// test.
vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

async function deliver(shopDomain: string, topic: string, payload: unknown) {
  pending = { shop: shopDomain, topic, payload };
  const { action } = await import("../../app/routes/webhooks.products");
  return action({
    request: new Request("https://example.invalid/webhooks/products", { method: "POST" }),
  } as never);
}

const productPayload = (
  productGid: string,
  variants: Array<{ gid: string; price: string }>,
  updatedAt: string,
) => ({
  admin_graphql_api_id: productGid,
  title: "Webhook product",
  status: "active",
  vendor: "Acme",
  tags: "chaos",
  updated_at: updatedAt,
  variants: variants.map((v) => ({
    admin_graphql_api_id: v.gid,
    title: "M",
    price: v.price,
    inventory_quantity: 3,
  })),
});

describe("chaos: product webhooks keeping the mirror current", () => {
  it("tombstones a variant removed from a product, and keeps the rest", async () => {
    await withChaos(
      "webhook-mirror",
      { catalog: { products: 2, variantsPerProduct: 3 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids, productOf } = chaos.fixture;

        const productGid = productOf.get(variantGids[0])!;
        const onThisProduct = variantGids.filter((gid) => productOf.get(gid) === productGid);
        expect(onThisProduct).toHaveLength(3);

        // The merchant deletes one of the three. Shopify sends the product with the
        // two that remain.
        const kept = onThisProduct.slice(0, 2);
        const removed = onThisProduct[2];

        await deliver(
          domain,
          "PRODUCTS_UPDATE",
          productPayload(
            productGid,
            kept.map((gid) => ({ gid, price: "42.00" })),
            new Date().toISOString(),
          ),
        );

        const gone = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: removed } },
        });
        expect(gone.deletedAt).not.toBeNull();

        // The two that remain are updated, not collateral damage.
        for (const gid of kept) {
          const row = await prisma.variantIndex.findUniqueOrThrow({
            where: { shopId_variantGid: { shopId, variantGid: gid } },
          });
          expect(row.deletedAt).toBeNull();
          expect(row.price).toBe(4_200n);
        }

        // And nothing on the other product was touched.
        for (const gid of variantGids.filter((g) => productOf.get(g) !== productGid)) {
          const row = await prisma.variantIndex.findUniqueOrThrow({
            where: { shopId_variantGid: { shopId, variantGid: gid } },
          });
          expect(row.deletedAt).toBeNull();
        }
      },
    );
  });

  it("ignores a delivery older than what the mirror already holds", async () => {
    await withChaos(
      "webhook-out-of-order",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids, productOf } = chaos.fixture;
        const gid = variantGids[0];
        const productGid = productOf.get(gid)!;

        const newer = "2026-08-26T12:00:00.000Z";
        const older = "2026-08-26T09:00:00.000Z";

        await deliver(domain, "PRODUCTS_UPDATE", productPayload(productGid, [{ gid, price: "99.00" }], newer));
        expect(
          (await prisma.variantIndex.findUniqueOrThrow({ where: { shopId_variantGid: { shopId, variantGid: gid } } }))
            .price,
        ).toBe(9_900n);

        // A delivery from three hours earlier arriving late. Applying it would undo a
        // fresh edit and leave the mirror confidently wrong.
        await deliver(domain, "PRODUCTS_UPDATE", productPayload(productGid, [{ gid, price: "11.00" }], older));
        expect(
          (await prisma.variantIndex.findUniqueOrThrow({ where: { shopId_variantGid: { shopId, variantGid: gid } } }))
            .price,
        ).toBe(9_900n);
      },
    );
  });

  it("does not read an empty variant list as a mass deletion", async () => {
    await withChaos(
      "webhook-empty-payload",
      { catalog: { products: 1, variantsPerProduct: 2 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids, productOf } = chaos.fixture;
        const productGid = productOf.get(variantGids[0])!;

        // A malformed or partial delivery. Tombstoning everything on the strength of it
        // would take the whole product out of every campaign.
        await deliver(domain, "PRODUCTS_UPDATE", productPayload(productGid, [], new Date().toISOString()));

        for (const gid of variantGids) {
          const row = await prisma.variantIndex.findUniqueOrThrow({
            where: { shopId_variantGid: { shopId, variantGid: gid } },
          });
          expect(row.deletedAt).toBeNull();
        }
      },
    );
  });
});
