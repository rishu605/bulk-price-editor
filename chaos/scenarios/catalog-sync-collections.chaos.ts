/**
 * The paginated catalogue sync reads a product's every collection, and every variant's image
 * (#738).
 *
 * It asked for `collections(first: 20)` and never paged, so a product in a twenty-first
 * collection was missing from every campaign scoped to it. And the follow-up page for a
 * product's 101st variant onwards left out `image { url }`, so those variants lost their own
 * image. The bulk path got both right, so only stores on this path were affected: the ones
 * below the bulk threshold, and any store whose bulk sync failed or returned nothing.
 *
 * Through the real `syncCatalog`, against a store served exactly as Shopify pages it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

const PRODUCT_ID = "gid://shopify/Product/collections-1";
const collection = (n: number) => ({ id: `gid://shopify/Collection/collections-${n}` });
const variant = (n: number) => ({
  id: `gid://shopify/ProductVariant/collections-${n}`,
  title: `Variant ${n}`,
  sku: `COLL-${n}`,
  barcode: null,
  price: "10.00",
  compareAtPrice: null,
  inventoryQuantity: 5,
  image: { url: `https://cdn.example/variant-${n}.png` },
  inventoryItem: { unitCost: { amount: "4.00", currencyCode: "USD" } },
});

/** One product in `collections` collections with `variants` variants, paged as Shopify pages them. */
function storeWith(collections: number, variants: number, options: { failCollections?: boolean } = {}) {
  const allCollections = Array.from({ length: collections }, (_, i) => collection(i));
  const allVariants = Array.from({ length: variants }, (_, i) => variant(i));
  const page = <T,>(all: T[], after: number, size: number) => {
    const nodes = all.slice(after, after + size);
    const next = after + nodes.length;
    return { pageInfo: { hasNextPage: next < all.length, endCursor: String(next) }, nodes };
  };
  // Only what the query asked for: a field it left out comes back absent, as from Shopify.
  const asked = (query: string, node: ReturnType<typeof variant>) => (query.includes("image { url }") ? node : { ...node, image: undefined });

  return {
    async graphql(query: string, options_?: { variables?: Record<string, unknown> }) {
      const after = Number((options_?.variables?.cursor as string | null) ?? "0");
      if (query.includes("AnchorProductCollectionsPage")) {
        if (options.failCollections) return { json: async () => ({ errors: [{ message: "Throttled" }] }) };
        return { json: async () => ({ data: { product: { collections: page(allCollections, after, 250) } } }) };
      }
      if (query.includes("AnchorProductVariantsPage")) {
        const variantsPage = page(allVariants, after, 250);
        return {
          json: async () => ({
            data: { product: { variants: { ...variantsPage, nodes: variantsPage.nodes.map((node) => asked(query, node)) } } },
          }),
        };
      }
      const first = page(allVariants, 0, 100);
      return {
        json: async () => ({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: PRODUCT_ID,
                  title: "In many collections",
                  vendor: "Anchor",
                  productType: "Test",
                  status: "ACTIVE",
                  tags: [],
                  updatedAt: new Date().toISOString(),
                  collections: page(allCollections, 0, 20),
                  variants: { ...first, nodes: first.nodes.map((node) => asked(query, node)) },
                },
              ],
            },
          },
        }),
      };
    },
  };
}

describe("chaos: the paginated catalogue sync", () => {
  it("mirrors a product's 45 collections, not 20, and the image of a variant past the first page", async () => {
    await withChaos("catalog-sync-collections", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const { syncCatalog } = await import("../../app/services/catalog-sync.server");

      const result = await syncCatalog(storeWith(45, 150), shopId, "USD");
      expect(result.errors).toEqual([]);
      expect(result.variants).toBe(150);

      const rows = await prisma.variantIndex.findMany({ where: { shopId, productGid: PRODUCT_ID }, select: { variantGid: true, collections: true, imageUrl: true } });
      expect(rows).toHaveLength(150);
      for (const row of rows) expect(row.collections, `${row.variantGid} lost collections past the 20th`).toHaveLength(45);
      const late = rows.find((row) => row.variantGid === variant(140).id);
      expect(late?.imageUrl, "a variant on a follow-up page lost its own image").toBe("https://cdn.example/variant-140.png");
    });
  });

  it("reports a product whose collections it could only read part of", async () => {
    await withChaos("catalog-sync-collections-failure", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { syncCatalog } = await import("../../app/services/catalog-sync.server");
      const result = await syncCatalog(storeWith(45, 3, { failCollections: true }), chaos.fixture.shopId, "USD");
      expect(result.variants).toBe(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("could not read past its first 20 collections");
      expect(result.errors[0]).toContain("Throttled");
    });
  });
});
