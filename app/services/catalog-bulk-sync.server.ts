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
 * Resumable by construction rather than by bookkeeping: every row is written keyed on
 * (shop, variant), so an import interrupted at row 300,000 and restarted rewrites the
 * first 300,000 harmlessly and finishes the rest. Recording a cursor would be a second
 * source of truth that could disagree with the database.
 *
 * The file is written minutes after Shopify read the products into it, so a row is written
 * only where the mirror holds nothing newer -- a campaign's price settled meanwhile stays
 * (#1087). `writeCatalogRows`, which the paginated sync writes through too, says how.
 *
 * ## Beside other bulk operations (#1081)
 *
 * Shopify counts bulk queries and bulk mutations apart. For the API version this app pins
 * (2026-07): "In API versions 2026-01 and higher, each app can run up to five bulk
 * operations of each type per shop simultaneously"; before 2026-01, one of each type
 * (https://shopify.dev/docs/api/usage/bulk-operations/queries#rate-limits). The schema says
 * it too: "Bulk query and bulk mutation operations can run at the same time per shop."
 *
 * So a campaign's bulk price update never stands in this import's way. It used to: the
 * import refused while *any* bulk operation was recorded running in the shop, on a rule of
 * one at a time that Shopify never had across types, and a 100,000-price update stopped
 * catalogue mirroring for the hour it ran (#832). What still keeps an import out is another
 * catalogue import -- this app's own rule, since two would read and rewrite the same rows --
 * and Shopify refusing it because the app already runs as many bulk queries there as it may.
 *
 * And it follows its own operation by id, `bulkOperation(id:)`. It used to poll
 * `currentBulkOperation(type: QUERY)`, which answers with the app's *most recent* bulk query
 * and is deprecated in 2026-07; with two running, it read the other one's status and file,
 * the misattribution #1054 fixed for campaigns.
 */

import { carryShopifyCosts } from "./baselines.server";
import { writeCatalogRows } from "./catalog-write.server";
import prisma from "../db.server";
import { CATALOG_BULK_QUERY, parseCatalogJsonl, type CatalogRow, type ParseStats } from "../lib/catalog/bulk-jsonl";
import { bulkOperationById, isTerminal, type BulkOperationState } from "../lib/execution/bulk-executor";
import { streamLines } from "../lib/execution/jsonl";
import { logger } from "../lib/logging/logger";
import type { AdminClient } from "../lib/execution/sync-executor";
import { isThrottledError, withRetry } from "../lib/shopify/budget";
import type { AnchorCatalogBulkQueryMutation } from "../types/admin.generated";

export const BULK_QUERY_RUN = `#graphql
  mutation AnchorCatalogBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

/**
 * The refusals that mean "this app already runs as many bulk queries in this shop as Shopify
 * allows". `BulkOperationUserErrorCode` has both, and the docs do not say which the limit
 * returns -- the same ambiguity #1054 met for mutations -- so either is read as that.
 */
const LIMIT_REACHED: ReadonlySet<string> = new Set(["LIMIT_REACHED", "OPERATION_IN_PROGRESS"]);

/** Rows per transaction. Big enough to amortise the round trip, small enough to hold. */
const BATCH = 1_000;

export interface BulkSyncProgress {
  variants: number;
  products: number;
}

export interface BulkSyncResult extends ParseStats {
  /** Rows actually written. Differs from `variants` only if a batch failed. */
  written: number;
  /**
   * Of those, rows the mirror held a newer version of than the file -- a campaign's price
   * settled, or a webhook applied, after Shopify read the product -- and kept (#1087).
   */
  kept: number;
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

/** How long this process polls a catalogue operation before giving up on it. */
export const BULK_POLL_BUDGET_MS = 30 * 60_000;

/**
 * How long a catalogue import's record may say CREATED or RUNNING before it is treated as
 * stranded (#733).
 *
 * The process that submits an import polls it for `BULK_POLL_BUDGET_MS` and always records
 * how it ended -- so a record still "running" well past that was left by a process that
 * stopped mid-poll: a dyno restart, a request that outlived its host. Shopify's own ceiling
 * is ten days, which is how long every catalogue sync for the shop would otherwise refuse.
 * If Shopify is in fact still building that file, a new import is one more of the five bulk
 * queries it runs at once, and past five Shopify refuses it, which is said in its terms.
 *
 * A catalogue rule only. A campaign's bulk mutation is polled on its own budget and goes on
 * for over an hour on a large store (#832); its records are the campaign path's to settle,
 * and retiring one here marked an update Shopify was still applying as failed (#1081).
 */
export const BULK_STRANDED_AFTER_MS = BULK_POLL_BUDGET_MS + 10 * 60_000;

/**
 * The catalogue import this shop has in flight, if any, after retiring stranded ones.
 *
 * Only the catalogue's own bulk queries count (`kind: QUERY`). Shopify runs bulk queries
 * and bulk mutations side by side, so a campaign's bulk price update running in the shop is
 * no reason to wait (#1081); a second catalogue import is, because two would read and
 * rewrite the same rows. A record that is only stale, rather than running, is marked FAILED
 * with `STRANDED` instead of blocking every catalogue sync for ten days.
 */
export async function catalogueImportInFlight(shopId: string): Promise<{ shopifyGid: string } | null> {
  const stranded = await prisma.bulkOperationRecord.updateMany({
    where: {
      shopId,
      kind: "QUERY",
      status: { in: ["CREATED", "RUNNING"] },
      submittedAt: { lt: new Date(Date.now() - BULK_STRANDED_AFTER_MS) },
    },
    data: { status: "FAILED", errorCode: "STRANDED", finishedAt: new Date() },
  });
  if (stranded.count > 0) {
    logger.warn("retired stranded catalogue import records", { shopId, count: stranded.count });
  }

  return prisma.bulkOperationRecord.findFirst({
    where: { shopId, kind: "QUERY", status: { in: ["CREATED", "RUNNING"] } },
    select: { shopifyGid: true },
  });
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
    kept: 0,
    bulkOperationGid: null,
    errors: [],
  };

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // One catalogue import per shop: a second would read and rewrite the same rows. Only the
  // catalogue's own imports count -- a campaign's bulk price update runs beside it (#1081).
  const inFlight = await catalogueImportInFlight(shopId);
  if (inFlight) {
    result.errors.push(
      "A catalogue sync is already running for this store, reading its catalogue from Shopify, so a " +
        "second one was not started. It finishes on its own; run the sync again after that if you still need to.",
    );
    return result;
  }

  const submitted = await withRetry(
    () => client.request<AnchorCatalogBulkQueryMutation>(BULK_QUERY_RUN, { query: CATALOG_BULK_QUERY }),
    isThrottledError,
  );

  const errors = submitted.data?.bulkOperationRunQuery?.userErrors ?? [];
  if (errors.length > 0 && errors.every((error) => error.code && LIMIT_REACHED.has(error.code))) {
    // Bulk queries this app has running in the shop that no record here holds -- sent by a
    // process that died before recording one, or still being built after a poll gave up.
    result.errors.push(
      "Shopify is already running as many bulk catalogue reads for Anchor in this store as it allows " +
        "at once, so it did not start this one. Nothing was imported from it; run the sync again in a " +
        "few minutes, once one of those has finished.",
    );
    return result;
  }
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

  // A poll that throws -- a dropped connection, a Shopify 5xx -- must still close the
  // record. Left CREATED, it made every later catalogue sync refuse as "already running",
  // for good (#733). Reported rather than thrown, so the caller falls back to the
  // paginated sync as it does for any other failed bulk import.
  let finished: BulkOperationState | null;
  try {
    finished = await pollUntilReady(client, operation.id, options, sleep);
  } catch (error) {
    await prisma.bulkOperationRecord.update({
      where: { shopifyGid: operation.id },
      data: { status: "FAILED", errorCode: "POLL_FAILED", finishedAt: new Date() },
    });
    logger.warn("lost contact with a catalogue bulk operation while polling", {
      shopId,
      error: error instanceof Error ? error.message : String(error),
    });
    result.errors.push(
      "Lost contact with Shopify while it was building the catalogue file, so nothing was imported from it. Try the sync again in a few minutes.",
    );
    return result;
  }

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
  // Shopify's costs onto the current baselines, which the guardrails read (#737).
  await carryShopifyCosts(shopId);

  logger.info("catalogue imported", {
    shopId,
    products: result.products,
    variants: result.variants,
    written: result.written,
    kept: result.kept,
    orphans: result.orphans,
    malformed: result.malformed,
  });

  return result;
}

/**
 * Polls this import's own operation, by id, until it ends or the budget runs out.
 *
 * By id because the app may have other bulk queries running in the shop, and the field that
 * answers "the current one" answers with the newest of them, whoever's it is (#1081).
 */
async function pollUntilReady(
  client: AdminClient,
  id: string,
  options: BulkSyncOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<BulkOperationState | null> {
  // Half an hour by default. A hundred-thousand-variant catalogue takes Shopify a few
  // minutes; the generous ceiling is for the store that is an order larger than that.
  const deadline = Date.now() + (options.timeoutMs ?? BULK_POLL_BUDGET_MS);
  const interval = options.pollIntervalMs ?? 5_000;
  let last: BulkOperationState | null = null;

  for (;;) {
    last = (await bulkOperationById(client, id)) ?? last;
    if (last && isTerminal(last.status)) return last;
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
      const { kept } = await writeCatalogRows(shopId, currency, rows);
      result.written += rows.length;
      result.kept += kept;
    } catch (error) {
      // One bad batch loses those rows, not the import. Every row is keyed on its variant,
      // so running the import again fills the gap rather than duplicating anything.
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
