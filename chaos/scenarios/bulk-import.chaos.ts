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
import { captureBaselines } from "../../app/services/baselines.server";
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

  it("leaves every imported variant priceable, not merely mirrored", async () => {
    /**
     * The property that matters, and the one the count assertions above all missed.
     *
     * A variant is not usable because it is in `variant_index`. It is usable when it has
     * a baseline, and baselines are captured from `price_surface_entries` — a second
     * table the bulk path did not write. So an imported variant was mirrored, counted,
     * listed in the catalogue, and could not be put in a campaign.
     *
     * The dashboard's remedy pointed the wrong way: "N variants have no baseline yet —
     * re-sync to capture them" ran the bulk path again and wrote no surface row again.
     * The warning could not be cleared by the only action offered for clearing it.
     *
     * It stayed hidden because the paginated path writes both tables and takes over
     * whenever the bulk path errors or returns nothing. Only a catalogue big enough for
     * the bulk path to succeed was affected — which is to say, the app was broken
     * specifically on the stores it exists for.
     *
     * Asserted as "can this variant be priced" rather than "does this row exist",
     * because the row is an implementation detail and the campaign is the point.
     */
    await withChaos(
      "bulk-import-priceable",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId } = chaos.fixture;

        await syncCatalogViaBulk(
          bulkClient("https://example.invalid/file.jsonl"),
          shopId,
          "USD",
          {
            fetchResult: chunked([product("A"), variant("a1", "A", "10.00")]) as never,
            sleep: async () => {},
          },
        );

        const imported = "gid://shopify/ProductVariant/a1";

        const surface = await prisma.priceSurfaceEntry.findUnique({
          where: {
            shopId_variantGid_surfaceKind_priceListGid: {
              shopId,
              variantGid: imported,
              surfaceKind: "BASE",
              priceListGid: "",
            },
          },
        });

        expect(surface, "imported variant has no base surface row").not.toBeNull();
        // The price came through the surface row too, not just the index row — a surface
        // entry with a null price captures a null baseline, which is the same dead end
        // one table further along.
        expect(surface?.livePrice).toBe(1_000n);

        await captureBaselines(shopId);

        const baseline = await prisma.baseline.findFirst({
          where: { shopId, variantGid: imported, supersededAt: null },
        });

        expect(baseline, "imported variant cannot be priced by a campaign").not.toBeNull();
        expect(baseline?.basePrice).toBe(1_000n);
      },
    );
  });
});