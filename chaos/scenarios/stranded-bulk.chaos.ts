/**
 * A catalogue bulk operation whose poll failed, or whose process died (#733).
 *
 * The catalogue sync records its bulk operation as CREATED, polls, and only then records
 * how it ended. Nothing caught a poll that threw -- a dropped connection, a Shopify 5xx,
 * a dyno restarting under Home's inline Re-sync -- so the record said CREATED for ever.
 * Every later catalogue sync refused as "already running", and so did every market sync,
 * silently: market mirroring was dead for that shop from then on.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import {
  BULK_STRANDED_AFTER_MS,
  bulkOperationInFlight,
  syncCatalogViaBulk,
} from "../../app/services/catalog-bulk-sync.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

/** Accepts the bulk query, then the poll fails the way a dropped connection does. */
function flakyClient(gid: string): AdminClient {
  return {
    async request<T>(query: string) {
      if (query.includes("bulkOperationRunQuery")) {
        return { data: { bulkOperationRunQuery: { bulkOperation: { id: gid, status: "CREATED" }, userErrors: [] } } as T };
      }
      if (query.includes("currentBulkOperation")) throw new Error("read ECONNRESET");
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    },
  };
}

/** Accepts the bulk query and reports it finished, with a one-product file. */
function goodClient(gid: string): AdminClient {
  return {
    async request<T>(query: string) {
      if (query.includes("bulkOperationRunQuery")) {
        return { data: { bulkOperationRunQuery: { bulkOperation: { id: gid, status: "CREATED" }, userErrors: [] } } as T };
      }
      if (query.includes("currentBulkOperation")) {
        return { data: { currentBulkOperation: { id: gid, status: "COMPLETED", url: "https://example.invalid/f.jsonl", objectCount: "2" } } as T };
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    },
  };
}

const file = (seed: number) => async function* stream() {
  yield `${JSON.stringify({ id: `gid://shopify/Product/stranded-${seed}`, title: "Stranded", status: "ACTIVE", tags: [], updatedAt: "2026-08-01T00:00:00Z" })}\n`;
  yield `${JSON.stringify({ id: `gid://shopify/ProductVariant/stranded-${seed}`, __parentId: `gid://shopify/Product/stranded-${seed}`, title: "M", price: "12.00" })}\n`;
};

const ALREADY_RUNNING = /already running/;

describe("chaos: a catalogue bulk operation left 'running'", () => {
  it("closes the record when a poll throws, and the next catalogue and market syncs run", async () => {
    await withChaos("stranded-bulk", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const gid = (n: number) => `gid://shopify/BulkOperation/stranded-${chaos.seed}-${n}`;

      const lost = await syncCatalogViaBulk(flakyClient(gid(1)), shopId, "USD", { sleep: async () => {} });
      expect(lost.errors.join(" ")).toMatch(/Lost contact with Shopify/);
      const record = await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { shopifyGid: gid(1) } });
      expect(record.status, "a poll that threw left the record running").toBe("FAILED");
      expect(record.errorCode).toBe("POLL_FAILED");

      const again = await syncCatalogViaBulk(goodClient(gid(2)), shopId, "USD", {
        sleep: async () => {},
        fetchResult: file(chaos.seed) as never,
      });
      expect(again.errors.join(" ")).not.toMatch(ALREADY_RUNNING);
      expect(again.written).toBe(1);

      const markets = await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      expect(markets.errors.join(" "), "the market sync still refused").not.toMatch(ALREADY_RUNNING);
    });
  });

  it("retires a record a dead process left running, but not one that is genuinely in flight", async () => {
    await withChaos("stranded-bulk-dead", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const stale = `gid://shopify/BulkOperation/dead-${chaos.seed}`;
      const fresh = `gid://shopify/BulkOperation/live-${chaos.seed}`;

      // Submitted, then the process restarted before it could record the end.
      await prisma.bulkOperationRecord.create({
        data: {
          shopId,
          shopifyGid: stale,
          kind: "QUERY",
          status: "CREATED",
          submittedAt: new Date(Date.now() - BULK_STRANDED_AFTER_MS - 60_000),
        },
      });
      expect(await bulkOperationInFlight(shopId)).toBeNull();
      expect((await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { shopifyGid: stale } })).errorCode).toBe("STRANDED");

      const markets = await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      expect(markets.errors.join(" ")).not.toMatch(ALREADY_RUNNING);

      // One submitted a minute ago is still somebody's, and both syncs still wait for it.
      await prisma.bulkOperationRecord.create({ data: { shopId, shopifyGid: fresh, kind: "QUERY", status: "RUNNING" } });
      expect((await bulkOperationInFlight(shopId))?.shopifyGid).toBe(fresh);
      expect((await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId)).errors.join(" ")).toMatch(ALREADY_RUNNING);
    });
  });
});
