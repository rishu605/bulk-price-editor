/**
 * The catalogue import that survives a real store.
 *
 * The paginated path in `catalog-sync.server.ts` is fine for a dev store and hopeless
 * at scale: 500K variants is ten thousand round trips against a rate limit that allows
 * a couple per second. This submits one `bulkOperationRunQuery`, waits for Shopify to
 * build the file, and streams the result in.
 *
 * Nothing is ever held whole. The response body is read as a stream, split into lines,
 * reassembled into rows and flushed in batches — so peak memory is a batch plus the
 * product-level index the join needs, not a few hundred megabytes of JSONL. That single
 * property is the difference between an import and one of this category's "the app
 * froze on our catalogue" reviews.
 *
 * Resumable by construction rather than by bookkeeping: every row is an upsert keyed on
 * (shop, variant), so an import interrupted at row 300,000 and restarted rewrites the
 * first 300,000 harmlessly and finishes the rest. Recording a cursor would be a second
 * source of truth that could disagree with the database.
 */

import prisma from "../db.server";
import { CATALOG_BULK_QUERY, parseCatalogJsonl, type CatalogRow, type ParseStats } from "../lib/catalog/bulk-jsonl";
import { streamLines } from "../lib/execution/jsonl";
import { logger } from "../lib/logging/logger";
import type { AdminClient } from "../lib/execution/sync-executor";
import { isThrottledError, withRetry } from "../lib/shopify/budget";

export const BULK_QUERY_RUN = `#graphql
  mutation AnchorCatalogBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export const CURRENT_BULK_QUERY = `#graphql
  query AnchorCurrentBulkQuery {
    currentBulkOperation(type: QUERY) {
      id status url partialDataUrl objectCount errorCode
    }
  }
`;

/** Rows per transaction. Big enough to amortise the round trip, small enough to hold. */
const BATCH = 1_000;

export interface BulkSyncProgress {
  variants: number;
  products: number;
}

export interface BulkSyncResult extends ParseStats {
  /** Rows actually written. Differs from `variants` only if a batch failed. */
  written: number;
  bulkOperationGid: string | null;
  errors: string[];
}

export interface BulkSyncOptions {
  /** Called as batches land, for the onboarding progress screen (P1.4). */
  onProgress?: (progress: BulkSyncProgress) => void | Promise<void>;
  /** How long to wait for Shopify to build the file before giving up and reporting. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected so tests need no network. Defaults to `fetch`. */
  fetchResult?: (url: string) => AsyncIterable<string>;
}

export async function syncCatalogViaBulk(
  client: AdminClient,
  shopId: string,
  currency: string,
  options: BulkSyncOptions = {},
): Promise<BulkSyncResult> {
  const result: BulkSyncResult = {
    products: 0,
    variants: 0,
    orphans: 0,
    malformed: 0,
    written: 0,
    bulkOperationGid: null,
    errors: [],
  };

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Shopify runs one bulk operation per shop at a time. Claimed in our own table too,
  // so a second tab or a scheduler tick finds out here rather than from a Shopify
  // error that names neither operation.
  const inFlight = await prisma.bulkOperationRecord.findFirst({
    where: { shopId, kind: "QUERY", status: { in: ["CREATED", "RUNNING"] } },
    select: { shopifyGid: true },
  });
  if (inFlight) {
    result.errors.push(
      "A catalogue import is already running for this shop. It will finish on its own; " +
        "starting a second one is not possible while Shopify is building the first.",
    );
    return result;
  }

  const submitted = await withRetry(
    () =>
      client.request<{
        bulkOperationRunQuery?: {
          bulkOperation?: { id: string; status: string } | null;
          userErrors?: Array<{ message: string }>;
        };
      }>(BULK_QUERY_RUN, { query: CATALOG_BULK_QUERY }),
    isThrottledError,
  );

  const errors = submitted.data?.bulkOperationRunQuery?.userErrors ?? [];
  if (errors.length > 0) {
    result.errors.push(`Shopify refused the catalogue query: ${errors.map((e) => e.message).join("; ")}`);
    return result;
  }

  const operation = submitted.data?.bulkOperationRunQuery?.bulkOperation;
  if (!operation) {
    result.errors.push("Shopify accepted the catalogue query but returned no operation to track.");
    return result;
  }

  result.bulkOperationGid = operation.id;

  await prisma.bulkOperationRecord.upsert({
    where: { shopifyGid: operation.id },
    create: { shopId, shopifyGid: operation.id, kind: "QUERY", status: "CREATED" },
    update: { status: "CREATED", submittedAt: new Date() },
  });

  const finished = await pollUntilReady(client, options, sleep);

  await prisma.bulkOperationRecord.update({
    where: { shopifyGid: operation.id },
    data: {
      status: finished?.status === "COMPLETED" ? "COMPLETED" : "FAILED",
      resultUrl: finished?.url ?? null,
      objectCount: finished?.objectCount ? BigInt(finished.objectCount) : null,
      errorCode: finished?.errorCode ?? null,
      finishedAt: new Date(),
    },
  });

  if (!finished || finished.status !== "COMPLETED") {
    result.errors.push(
      finished
        ? `The catalogue import ended as ${finished.status}${finished.errorCode ? ` (${finished.errorCode})` : ""}. Nothing was imported; try again.`
        : "Shopify did not finish building the catalogue file in time. Nothing was imported; try again.",
    );
    return result;
  }

  // A completed operation over an empty catalogue has no file at all.
  if (!finished.url) return result;

  const source = options.fetchResult ?? streamHttp;
  await ingest(source(finished.url), shopId, currency, result, options.onProgress);

  logger.info("catalogue imported", {
    shopId,
    products: result.products,
    variants: result.variants,
    written: result.written,
    orphans: result.orphans,
    malformed: result.malformed,
  });

  return result;
}

interface BulkState {
  id: string;
  status: string;
  url?: string | null;
  objectCount?: string | number | null;
  errorCode?: string | null;
}

async function pollUntilReady(
  client: AdminClient,
  options: BulkSyncOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<BulkState | null> {
  // Half an hour by default. A hundred-thousand-variant catalogue takes Shopify a few
  // minutes; the generous ceiling is for the store that is an order larger than that.
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  const interval = options.pollIntervalMs ?? 5_000;
  let last: BulkState | null = null;

  for (;;) {
    const response = await withRetry(
      () => client.request<{ currentBulkOperation?: BulkState | null }>(CURRENT_BULK_QUERY, {}),
      isThrottledError,
    );

    last = response.data?.currentBulkOperation ?? last;
    if (last && last.status !== "CREATED" && last.status !== "RUNNING") return last;
    if (Date.now() >= deadline) return last;

    await sleep(interval);
  }
}

/** Streams the result file into `variant_index` in batches. */
async function ingest(
  chunks: AsyncIterable<string>,
  shopId: string,
  currency: string,
  result: BulkSyncResult,
  onProgress?: BulkSyncOptions["onProgress"],
): Promise<void> {
  let batch: CatalogRow[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];

    try {
      await writeBatch(shopId, currency, rows);
      result.written += rows.length;
    } catch (error) {
      // One bad batch loses those rows, not the import. Every row is an upsert, so
      // running the import again fills the gap rather than duplicating anything.
      result.errors.push(
        `A batch of ${rows.length} variants could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await onProgress?.({ variants: result.written, products: result.products });
  };

  for await (const row of parseCatalogJsonl(streamLines(chunks), currency, result)) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }

  await flush();
}

/**
 * One batch, one transaction.
 *
 * `createMany` with `skipDuplicates` would be faster and would silently ignore every
 * variant whose price had changed since the last import, which is the one thing this
 * table exists to know.
 */
async function writeBatch(shopId: string, currency: string, rows: CatalogRow[]): Promise<void> {
  await prisma.$transaction(
    rows.flatMap((row) => [
      prisma.variantIndex.upsert({
        where: { shopId_variantGid: { shopId, variantGid: row.variantGid } },
        create: {
          shopId,
          variantGid: row.variantGid,
          productGid: row.productGid,
          title: row.title,
          sku: row.sku,
          barcode: row.barcode,
          price: row.price ? BigInt(row.price.amount) : null,
          compareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
          cost: row.cost ? BigInt(row.cost.amount) : null,
          currency: row.price?.currency ?? currency,
          inventoryQty: row.inventoryQty,
          status: row.status,
          vendor: row.vendor,
          productType: row.productType,
          tags: row.tags,
          collections: row.collections,
          imageUrl: row.imageUrl,
          remoteUpdatedAt: row.remoteUpdatedAt,
        },
        update: {
          productGid: row.productGid,
          title: row.title,
          sku: row.sku,
          barcode: row.barcode,
          price: row.price ? BigInt(row.price.amount) : null,
          compareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
          cost: row.cost ? BigInt(row.cost.amount) : null,
          currency: row.price?.currency ?? currency,
          inventoryQty: row.inventoryQty,
          status: row.status,
          vendor: row.vendor,
          productType: row.productType,
          tags: row.tags,
          collections: row.collections,
          imageUrl: row.imageUrl,
          remoteUpdatedAt: row.remoteUpdatedAt,
          // A variant reappearing after deletion clears its tombstone.
          deletedAt: null,
          syncedAt: new Date(),
        },
      }),
      // The base-surface row, in the same transaction as the index row.
      //
      // This was missing, and the consequence was that the bulk path could not produce a
      // priceable variant. Baselines are captured from `price_surface_entries`, not from
      // `variant_index` — so a variant imported here got mirrored, counted, and shown in
      // the catalogue, and then had no baseline, and a variant with no baseline cannot be
      // included in a campaign.
      //
      // The dashboard's remedy made it worse rather than better: "N variants have no
      // baseline yet — re-sync to capture them" ran the bulk path again, which again wrote
      // no surface row. The warning could not be cleared by the only action offered for
      // clearing it.
      //
      // Small stores hid it. The paginated path writes both tables and runs whenever the
      // bulk path errors or returns nothing, so the failure was invisible until a
      // catalogue was big enough for the bulk path to succeed — which is to say, the app
      // was broken specifically on the stores it exists for.
      //
      // Same transaction rather than a second pass, because the two tables disagreeing is
      // the bug itself, and a second pass can fail on its own.
      prisma.priceSurfaceEntry.upsert({
        where: {
          shopId_variantGid_surfaceKind_priceListGid: {
            shopId,
            variantGid: row.variantGid,
            surfaceKind: "BASE",
            priceListGid: "",
          },
        },
        create: {
          shopId,
          variantGid: row.variantGid,
          surfaceKind: "BASE",
          priceListGid: "",
          currency: row.price?.currency ?? currency,
          livePrice: row.price ? BigInt(row.price.amount) : null,
          liveCompareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
        },
        update: {
          currency: row.price?.currency ?? currency,
          livePrice: row.price ? BigInt(row.price.amount) : null,
          liveCompareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
          syncedAt: new Date(),
        },
      }),
    ]),
  );
}

/** Reads a result file as text chunks, never buffering the whole body. */
async function* streamHttp(url: string): AsyncGenerator<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the catalogue file: ${response.status}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  yield decoder.decode();
}
