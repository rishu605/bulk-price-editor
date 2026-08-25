/**
 * The catalogue import, against a real database.
 *
 * The parser has its own unit tests. What those cannot check is the property the ticket
 * actually turns on: an import interrupted partway and started again must finish the
 * job without duplicating what it already wrote — and that is a statement about
 * Postgres, not about JSONL.
 *
 * It is resumable by construction rather than by bookkeeping. Every row is an upsert
 * keyed on (shop, variant), so a restart rewrites what it already had and carries on.
 * Recording a cursor would be a second source of truth that could disagree with the
 * database, and disagreeing about which variants exist is how a campaign misses
 * products.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { syncCatalogViaBulk } from "../../app/services/catalog-bulk-sync.server";
import { withChaos } from "../harness/scenario";

/** A Shopify that accepts a bulk query and reports it finished immediately. */
function bulkClient(url: string, gid = "gid://shopify/BulkOperation/1"): AdminClient {
  return {
    async request<T>(query: string) {
      if (query.includes("bulkOperationRunQuery")) {
        return {
          data: {
            bulkOperationRunQuery: { bulkOperation: { id: gid, status: "CREATED" }, userErrors: [] },
          } as T,
        };
      }
      if (query.includes("currentBulkOperation")) {
        return {
          data: { currentBulkOperation: { id: gid, status: "COMPLETED", url, objectCount: "3" } } as T,
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    },
  };
}

const product = (id: string) =>
  JSON.stringify({
    id: `gid://shopify/Product/${id}`,
    title: `Imported ${id}`,
    vendor: "Acme",
    productType: "Boots",
    status: "ACTIVE",
    tags: ["imported"],
    updatedAt: "2026-08-01T00:00:00Z",
  });

const variant = (id: string, parent: string, price: string) =>
  JSON.stringify({
    id: `gid://shopify/ProductVariant/${id}`,
    __parentId: `gid://shopify/Product/${parent}`,
    title: "M",
    sku: `SKU-${id}`,
    price,
    inventoryQuantity: 4,
  });

/**
 * Serves the file in awkward chunks.
 *
 * Seven bytes at a time, so lines are split across chunk boundaries in the middle of
 * words and the streaming line-splitter is genuinely exercised rather than being handed
 * one tidy string.
 */
function chunked(lines: string[]) {
  const body = `${lines.join("\n")}\n`;
  return async function* stream() {
    for (let i = 0; i < body.length; i += 7) yield body.slice(i, i + 7);
  };
}

describe("chaos: the catalogue bulk import", () => {
  it("imports, and importing again neither duplicates nor loses anything", async () => {
    await withChaos(
      "bulk-import",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        const before = await prisma.variantIndex.count({ where: { shopId } });

        const file = chunked([
          product("A"),
          variant("a1", "A", "10.00"),
          variant("a2", "A", "20.00"),
          product("B"),
          variant("b1", "B", "30.00"),
        ]);

        const first = await syncCatalogViaBulk(
          bulkClient("https://example.invalid/file.jsonl"),
          shopId,
          "USD",
          { fetchResult: file as never, sleep: async () => {} },
        );

        expect(first.errors).toEqual([]);
        expect(first.products).toBe(2);
        expect(first.variants).toBe(3);
        expect(first.written).toBe(3);
        expect(first.orphans).toBe(0);

        const afterFirst = await prisma.variantIndex.count({ where: { shopId } });
        expect(afterFirst).toBe(before + 3);

        // Money arrives as integer minor units, never a float.
        const row = await prisma.variantIndex.findUniqueOrThrow({
          where: { shopId_variantGid: { shopId, variantGid: "gid://shopify/ProductVariant/a1" } },
        });
        expect(row.price).toBe(1_000n);
        expect(row.vendor).toBe("Acme");
        expect(row.tags).toEqual(["imported"]);

        // ------------------------------------------------------- run it again
        // What a resumed import does. Every row is an upsert, so rewriting the ones
        // already there is harmless and the count must not move.
        const second = await syncCatalogViaBulk(
          bulkClient("https://example.invalid/file.jsonl", "gid://shopify/BulkOperation/2"),
          shopId,
          "USD",
          { fetchResult: file as never, sleep: async () => {} },
        );

        expect(second.errors).toEqual([]);
        expect(second.written).toBe(3);
        expect(await prisma.variantIndex.count({ where: { shopId } })).toBe(afterFirst);
      },
    );
  });

  it("refuses to start a second import while one is in flight", async () => {
    await withChaos(
      "bulk-import-concurrent",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId } = chaos.fixture;

        // Shopify allows one bulk operation per shop. Claiming it here means a second
        // tab finds out in our words rather than from a Shopify error naming neither
        // operation.
        await prisma.bulkOperationRecord.create({
          data: {
            shopId,
            shopifyGid: "gid://shopify/BulkOperation/inflight",
            kind: "QUERY",
            status: "RUNNING",
          },
        });

        const result = await syncCatalogViaBulk(
          bulkClient("https://example.invalid/file.jsonl"),
          shopId,
          "USD",
          { sleep: async () => {} },
        );

        expect(result.errors[0]).toMatch(/already running/i);
        expect(result.written).toBe(0);
      },
    );
  });
});
