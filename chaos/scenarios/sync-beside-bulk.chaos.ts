/**
 * The catalogue and market syncs beside a campaign's bulk price update (#1081).
 *
 * Both syncs refused to start while any bulk operation was recorded running in the shop,
 * whatever its type -- so a campaign's bulk mutation, which on a large store runs for over
 * an hour (#832), stopped catalogue and market mirroring for all of it. The market sync said
 * "A catalogue sync is already running for this shop ... Shopify allows one bulk operation at
 * a time", on Home, when no catalogue sync was running at all.
 *
 * The rule behind it was out of date. Shopify counts bulk queries and bulk mutations apart:
 * "In API versions 2026-01 and higher, each app can run up to five bulk operations of each
 * type per shop simultaneously", and before 2026-01 one of each type
 * (https://shopify.dev/docs/api/usage/bulk-operations/queries#rate-limits). This app pins
 * 2026-07. A catalogue read never had to wait for a price update, and the market sync runs
 * no bulk operation at all: it pages through price lists.
 *
 * Driven against the fake store, which runs bulk queries and mutations side by side and
 * holds an operation running for as long as a scenario needs.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { CATALOG_BULK_QUERY } from "../../app/lib/catalog/bulk-jsonl";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { BULK_STRANDED_AFTER_MS, syncCatalogViaBulk } from "../../app/services/catalog-bulk-sync.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { runFullSync } from "../../app/services/sync-job.server";
import { chaosAdminClient } from "../harness/http-client";
import { CHAOS_ACTOR, withChaos, type ChaosContext } from "../harness/scenario";

/** Waits for something running in the background, or fails saying what. */
async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The client, keeping every document it sends. */
function recording(client: AdminClient, sent: string[]): AdminClient {
  return {
    request(query, variables) {
      sent.push(query);
      return client.request(query, variables);
    },
  };
}

/** A bulk read of this app's that Anchor holds no record of: sent by a process that died first. */
async function unrecordedBulkRead(chaos: ChaosContext): Promise<string> {
  const response = (await chaos.fake.request(
    "mutation Unrecorded($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id } userErrors { message } } }",
    { query: CATALOG_BULK_QUERY },
  )) as { data?: { bulkOperationRunQuery?: { bulkOperation?: { id: string } | null } } };
  const id = response.data?.bulkOperationRunQuery?.bulkOperation?.id;
  if (!id) throw new Error("The fake refused the unrecorded bulk read.");
  return id;
}

const SPEC = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, pollsBeforeComplete: 1_000 };

describe("chaos: the syncs beside a campaign's bulk price update", () => {
  it("reads the catalogue in bulk and mirrors the markets while a campaign's bulk update runs, and says nothing is in the way", async () => {
    await withChaos("sync-beside-bulk", SPEC, async (chaos) => {
      const { shopId, variantGids, productOf } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // The store carries the tag the fixture's campaign selects by, so a re-import keeps
      // its variants in scope; and one market with a price set by hand, for the market sync.
      for (const product of new Set(productOf.values())) chaos.fake.addMerchantTag(product, "chaos");
      chaos.fake.priceLists.push({
        id: `gid://shopify/PriceList/beside-${chaos.seed}`,
        name: "Germany",
        currency: "EUR",
        adjustment: null,
        catalog: { id: `gid://shopify/MarketCatalog/beside-${chaos.seed}`, title: "Germany", __typename: "MarketCatalog" },
        country: "DE",
        prices: [{ variantGid: variantGids[0], amount: "9.00", compareAt: null, originType: "FIXED" }],
      });

      // The campaign's bulk apply: accepted by Shopify, and held running.
      const applying = chaos.apply({ forcePath: "bulk" });
      applying.catch(() => undefined);
      const update = await until("the campaign's bulk operation to be accepted", () =>
        prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "MUTATION", status: { in: ["CREATED", "RUNNING"] } } }),
      );
      // Operations submitted from here finish after a poll; the campaign's stays running.
      chaos.fake.pollsBeforeComplete = 1;

      // The whole sync, as Home's Sync button and the worker run it.
      const sync = await runFullSync(shopId, client, CHAOS_ACTOR).catch((error: unknown) => error);

      const read = await prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "QUERY" } });
      expect(read?.status, "the catalogue sync did not read the catalogue in bulk beside the campaign's update").toBe("COMPLETED");
      expect(sync, "the sync stopped").not.toBeInstanceOf(Error);
      const summary = sync as Awaited<ReturnType<typeof runFullSync>>;
      expect(summary.errors, "the sync reported a problem that is not there").toEqual([]);
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      expect(shop.syncFailure, "Home was told a part of the sync did not run").toBeNull();
      expect(await prisma.variantIndex.count({ where: { shopId, deletedAt: null } })).toBe(variantGids.length);
      const market = await prisma.priceSurfaceEntry.findFirst({ where: { shopId, surfaceKind: "MARKET", variantGid: variantGids[0] } });
      expect(market?.livePrice, "the market's price was not mirrored").toBe(900n);

      // The market sync on its own, as the worker's market job runs it.
      const markets = await syncMarkets(client, shopId);
      expect(markets.errors, "the market sync refused beside a campaign's update").toEqual([]);
      expect(markets.priceLists).toBe(1);

      // The campaign's operation was left alone, still running.
      const after = await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { id: update.id } });
      expect({ status: after.status, errorCode: after.errorCode }).toEqual({ status: "RUNNING", errorCode: null });

      // Shopify finishes the update, and the campaign ends verified-clean.
      chaos.fake.finishBulkOnNextPoll();
      const outcome = await applying;
      await chaos.expectHonest(outcome.runId);
      expect(outcome.clean).toBe(true);
    });
  });

  it("leaves alone a campaign's bulk update that has run longer than a catalogue read is ever polled", async () => {
    await withChaos("sync-beside-bulk-long-update", { ...SPEC, pollsBeforeComplete: 1 }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // A large store's bulk update runs for over an hour (#832), and Shopify carries on with
      // it after the run that sent it stops watching. The catalogue's stranded rule is about
      // its own reads, which are polled for half an hour; it is not the catalogue's to retire.
      const update = await prisma.bulkOperationRecord.create({
        data: {
          shopId,
          shopifyGid: `gid://shopify/BulkOperation/long-update-${chaos.seed}-${Date.now()}`,
          kind: "MUTATION",
          status: "RUNNING",
          submittedAt: new Date(Date.now() - BULK_STRANDED_AFTER_MS - 60_000),
        },
      });

      const read = await syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 50 });
      expect(read.errors).toEqual([]);
      expect(read.written).toBe(variantGids.length);

      const after = await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { id: update.id } });
      expect(
        { status: after.status, errorCode: after.errorCode, finishedAt: after.finishedAt },
        "the catalogue sync retired a campaign's running update as stranded",
      ).toEqual({ status: "RUNNING", errorCode: null, finishedAt: null });
    });
  });

  it("still keeps two catalogue syncs apart, and the second says the catalogue sync is running", async () => {
    await withChaos("sync-beside-bulk-two-reads", SPEC, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      const first = syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 50 });
      first.catch(() => undefined);
      await until("the first catalogue read to be accepted", () => prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "QUERY" } }));

      const second = await syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 50 });
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toMatch(/^A catalogue sync is already running for this store, reading its catalogue from Shopify/);
      expect(second.errors[0], "the refusal does not say what to do").toMatch(/run the sync again/i);
      expect(second.errors[0]).not.toMatch(/one bulk operation/i);
      expect(second.written).toBe(0);
      expect(await prisma.bulkOperationRecord.count({ where: { shopId, kind: "QUERY" } }), "a second bulk read was sent").toBe(1);

      chaos.fake.finishBulkOnNextPoll();
      const done = await first;
      expect(done.errors).toEqual([]);
      expect(done.written).toBe(variantGids.length);
    });
  });

  it("follows its own bulk read by id, not whichever of the app's is newest", async () => {
    await withChaos("sync-beside-bulk-own-read", SPEC, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const sent: string[] = [];
      const client = recording(chaosAdminClient(chaos.server.endpoint()), sent);

      const sync = syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 50 });
      sync.catch(() => undefined);
      const ours = await until("the catalogue read to be accepted", () => prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "QUERY" } }));

      // A newer bulk read of the app's, which finishes first.
      chaos.fake.pollsBeforeComplete = 0;
      await unrecordedBulkRead(chaos);

      const early = await Promise.race([
        sync.then(() => "ended"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still reading"), 1_000)),
      ]);
      expect(early, "the sync took the newer read's answer for its own").toBe("still reading");

      chaos.fake.finishBulkOnNextPoll();
      const done = await sync;
      expect(done.errors).toEqual([]);
      expect(done.written).toBe(variantGids.length);
      expect(done.bulkOperationGid).toBe(ours.shopifyGid);
      const record = await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { id: ours.id } });
      expect(record.resultUrl, "the record holds another read's file").toContain(ours.shopifyGid.split("/").at(-1));
      expect(sent.filter((query) => query.includes("currentBulkOperation")), "polled the deprecated newest-operation field").toEqual([]);
    });
  });

  it("says so in Shopify's terms when the app already has as many bulk reads running as Shopify allows", async () => {
    await withChaos("sync-beside-bulk-limit", SPEC, async (chaos) => {
      const { shopId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // The stricter reading, one at a time; five behave the same at six.
      chaos.fake.bulkQueryLimit = 1;
      await unrecordedBulkRead(chaos);

      const refused = await syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 50 });
      expect(refused.errors).toHaveLength(1);
      expect(refused.errors[0]).toMatch(/^Shopify is already running as many bulk catalogue reads for Anchor in this store as it allows at once/);
      expect(refused.errors[0]).toMatch(/Nothing was imported/);
      expect(refused.errors[0], "the refusal does not say what to do").toMatch(/run the sync again/i);
      expect(refused.written).toBe(0);
      expect(await prisma.bulkOperationRecord.count({ where: { shopId, kind: "QUERY" } }), "a refused read was recorded as running").toBe(0);
    });
  });
});
