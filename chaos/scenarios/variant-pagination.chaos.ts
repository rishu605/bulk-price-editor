/**
 * A product with more variants than one page holds.
 *
 * Found on a real 100K store: `variants(first: 100)` on the catalogue page query dropped
 * 1,948 of a 2,048-variant product's variants, silently. The store had all of them;
 * the mirror had a twentieth. A campaign covering that product would have priced 100
 * variants, left 1,948 at their old prices, and reported the run clean — because every
 * row it knew about did land.
 *
 * That is the exact failure this product exists to prevent, and nothing caught it: the
 * page size looks like a page size until a product is bigger than one.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/** A variant node in the shape the sync reads. */
const variant = (n: number) => ({
  id: `gid://shopify/ProductVariant/pagination-${n}`,
  title: `Variant ${n}`,
  sku: `SKU-${n}`,
  barcode: null,
  price: "10.00",
  compareAtPrice: null,
  inventoryQuantity: 5,
  inventoryItem: { unitCost: { amount: "4.00", currencyCode: "USD" } },
});

const PRODUCT_ID = "gid://shopify/Product/pagination-1";

/**
 * A store whose one product has `total` variants, served 100 on the product page and 250
 * per follow-up — which is exactly how Shopify serves them.
 */
function storeWith(total: number) {
  const all = Array.from({ length: total }, (_, i) => variant(i));
  let followUps = 0;

  return {
    followUpCount: () => followUps,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      if (query.includes("AnchorProductVariantsPage")) {
        followUps += 1;
        const after = Number((options?.variables?.cursor as string | null) ?? "100");
        const slice = all.slice(after, after + 250);
        const next = after + slice.length;

        return {
          json: async () => ({
            data: {
              product: {
                variants: {
                  pageInfo: { hasNextPage: next < all.length, endCursor: String(next) },
                  nodes: slice,
                },
              },
            },
          }),
        };
      }

      const first = all.slice(0, 100);
      return {
        json: async () => ({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: PRODUCT_ID,
                  title: "A product with too many variants",
                  vendor: "Anchor",
                  productType: "Test",
                  status: "ACTIVE",
                  tags: [],
                  updatedAt: new Date().toISOString(),
                  collections: { nodes: [] },
                  variants: {
                    pageInfo: { hasNextPage: all.length > 100, endCursor: "100" },
                    nodes: first,
                  },
                },
              ],
            },
          },
        }),
      };
    },
  };
}

async function mirroredVariants(shopId: string): Promise<number> {
  return prisma.variantIndex.count({ where: { shopId, productGid: PRODUCT_ID } });
}

describe("chaos: a product with more variants than one page", () => {
  it("mirrors all 2,048, not the first 100", async () => {
    await withChaos(
      "variant-pagination-2048",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { syncCatalog } = await import("../../app/services/catalog-sync.server");
        const store = storeWith(2_048);

        const result = await syncCatalog(store, chaos.fixture.shopId, "USD");

        expect(result.errors).toEqual([]);
        expect(result.variants).toBe(2_048);
        expect(await mirroredVariants(chaos.fixture.shopId)).toBe(2_048);

        // 100 on the page, then 250 a time: eight follow-ups, not one per variant.
        expect(store.followUpCount()).toBe(8);
      },
    );
  });

  it("asks for nothing extra when one page was enough", async () => {
    await withChaos(
      "variant-pagination-small",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { syncCatalog } = await import("../../app/services/catalog-sync.server");
        const store = storeWith(40);

        const result = await syncCatalog(store, chaos.fixture.shopId, "USD");

        expect(result.variants).toBe(40);
        expect(store.followUpCount()).toBe(0);
      },
    );
  });

  it("reports a product it could only read part of, rather than mirroring it quietly", async () => {
    await withChaos(
      "variant-pagination-failure",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { syncCatalog } = await import("../../app/services/catalog-sync.server");
        const store = storeWith(2_048);

        // The follow-up fails. The first hundred are still real and worth mirroring, but
        // the product is now partly mirrored — and a partly mirrored product is one whose
        // campaigns will be partly applied.
        const broken = {
          async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
            if (query.includes("AnchorProductVariantsPage")) {
              return { json: async () => ({ errors: [{ message: "Throttled" }] }) };
            }
            return store.graphql(query, options);
          },
        };

        const result = await syncCatalog(broken, chaos.fixture.shopId, "USD");

        expect(result.variants).toBe(100);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("could not read past the first page");
        expect(result.errors[0]).toContain("Throttled");
      },
    );
  });
});
