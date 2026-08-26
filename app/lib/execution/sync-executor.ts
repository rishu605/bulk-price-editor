/**
 * The synchronous write path: `productVariantsBulkUpdate`, grouped per product,
 * through the rate-limit budget manager, followed by read-back verification.
 *
 * Used for small runs only. Above roughly a thousand rows the bulk-operation path
 * wins on every dimension, and given a standard shop restores 50 points/second
 * against a ~100-point variant update, large synchronous runs are not merely slow
 * but infeasible.
 *
 * Two details that are easy to get wrong:
 *
 *   The mutation is PER PRODUCT. Iterating per variant multiplies the request count
 *   by the average variant count and burns the budget for nothing.
 *
 *   `userErrors` is not an exception. Shopify returns HTTP 200 with a populated
 *   userErrors array when a write is rejected, so a naive implementation reports
 *   success for writes that never happened — precisely the silent-failure mode the
 *   ledger exists to prevent.
 */

import { formatMoney, type Money } from "../money/money";
import { readBackVerdict } from "./read-back";
import type { PlannedRow } from "../planning/types";
import { isThrottledError, RateLimitBudget, withRetry } from "../shopify/budget";
import {
  classifyFailure,
  stopsTheRun,
  type FailureClass,
  type FailureReason,
} from "./classify";
import type { QueryCost } from "../shopify/budget";

/** Minimal shape of the Admin GraphQL client, so tests can inject a fake. */
export interface AdminClient {
  request<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data?: T; extensions?: { cost?: QueryCost } }>;
}

export type ExecutedStatus =
  | "verified"
  | "failed"
  | "applied-unverified"
  /** Variant deleted in Shopify while the run was in flight -- not a failure (E4). */
  | "skipped-deleted";

export interface ExecutedRow {
  row: PlannedRow;
  status: ExecutedStatus;
  /** Human-readable, because support reads these. */
  failureReason?: string;
  /** What the read-back actually observed, when it disagreed. */
  observedPrice?: Money;
  /** What the merchant should do about it, in plain words. */
  guidance?: string;
  /** Retryable, terminal for this row, terminal for the run, or the merchant's to fix. */
  failureClass?: FailureClass;
  /** Machine-readable, so the UI can group rows that failed for the same reason. */
  failureCode?: FailureReason;
}

export interface ExecuteResult {
  rows: ExecutedRow[];
  verified: number;
  failed: number;
  /** Applied but not sampled for read-back. */
  unverified: number;
  /** True only when every row verified — the "verified clean" bar. */
  clean: boolean;
  /** Set when the run stopped early because nothing further could succeed. */
  stoppedEarly?: string;
}

export interface ExecuteOptions {
  client: AdminClient;
  budget: RateLimitBudget;
  /** Maps a variant gid to its product gid; the mutation is per product. */
  productOf: (variantGid: string) => string;
  /** Fraction of successful rows to read back. Default 0.1 (>=10% per RFC §5). */
  verifySampleRate?: number;
  /** Estimated cost per variant write, for budget reservation. */
  costPerVariant?: number;
  /**
   * Called as each product group settles.
   *
   * The caller uses it to stamp liveness: a run that cannot say it is still alive is
   * indistinguishable from one whose process died, and the reaper has to be able to
   * tell those apart (P2.8).
   */
  onProgress?: (done: number, total: number) => void | Promise<void>;
  /** Deterministic sampling hook for tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export const PRODUCT_VARIANTS_BULK_UPDATE = `#graphql
  mutation AnchorProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

export const VARIANT_PRICES_QUERY = `#graphql
  query AnchorVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id price compareAtPrice }
    }
  }
`;

interface BulkUpdateResponse {
  productVariantsBulkUpdate?: {
    productVariants?: Array<{ id: string; price: string; compareAtPrice: string | null }>;
    userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  };
}

interface NodesResponse {
  nodes?: Array<{ id: string; price?: string; compareAtPrice?: string | null } | null>;
}

/**
 * Builds the variant input for one row.
 *
 * `compareAtPrice` is only included when the campaign actually decided something
 * about it. Sending `null` unconditionally would wipe every merchant's compare-at
 * on any price change — which is why the planner tracks "clear it" and "leave it
 * alone" as distinct states rather than collapsing both to null.
 */
export function toVariantInput(row: PlannedRow): Record<string, unknown> {
  const input: Record<string, unknown> = { id: row.ref.variantGid };
  if (row.intendedPrice) input.price = formatMoney(row.intendedPrice);
  if (row.intendedCompareAtSet) {
    input.compareAtPrice = row.intendedCompareAt
      ? formatMoney(row.intendedCompareAt)
      : null;
  }
  return input;
}

export async function executeSync(
  rows: PlannedRow[],
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const {
    client,
    budget,
    productOf,
    verifySampleRate = 0.1,
    costPerVariant = 100,
    onProgress,
    random = Math.random,
    sleep,
    maxAttempts = 5,
  } = options;

  const writable = rows.filter((r) => r.status !== "skipped" && r.intendedPrice);
  const results = new Map<string, ExecutedRow>();

  // Set when a failure means no further row can succeed; stops the loop.
  let terminalRunFailure: string | undefined;

  // Skipped rows pass straight through: they were never going to be written, and
  // reporting them as failures would misrepresent a deliberate policy decision.
  for (const row of rows) {
    if (row.status === "skipped" || !row.intendedPrice) {
      results.set(row.ref.variantGid, { row, status: "verified" });
    }
  }

  // The mutation is per product, so group first.
  const byProduct = new Map<string, PlannedRow[]>();
  for (const row of writable) {
    const product = productOf(row.ref.variantGid);
    const group = byProduct.get(product);
    if (group) group.push(row);
    else byProduct.set(product, [row]);
  }

  let settled = 0;
  for (const [productId, group] of byProduct) {
    await budget.reserve(costPerVariant * group.length);

    try {
      const response = await withRetry(
        () =>
          client.request<BulkUpdateResponse>(PRODUCT_VARIANTS_BULK_UPDATE, {
            productId,
            variants: group.map(toVariantInput),
          }),
        isThrottledError,
        { maxAttempts, sleep },
      );

      budget.observe(response.extensions?.cost);

      const payload = response.data?.productVariantsBulkUpdate;
      const userErrors = payload?.userErrors ?? [];

      // Map each userError back to the row it concerns. Shopify addresses fields
      // positionally (["variants", "2", "price"]), so the index identifies the row.
      const errorsByIndex = new Map<number, string>();
      let groupWideError: string | undefined;

      for (const error of userErrors) {
        const index = indexFromField(error.field);
        const text = error.code ? `${error.code}: ${error.message}` : error.message;
        if (index === undefined) groupWideError = text;
        else errorsByIndex.set(index, text);
      }

      group.forEach((row, index) => {
        const reason = errorsByIndex.get(index) ?? groupWideError;

        if (!reason) {
          results.set(row.ref.variantGid, { row, status: "applied-unverified" });
          return;
        }

        const classified = classifyFailure(reason);

        // A variant deleted while the run was in flight is not a failure -- the
        // merchant deleted it. Reporting it as one trains people to ignore failures,
        // which is how a real failure goes unnoticed (E4).
        if (classified.reason === "variant-deleted") {
          results.set(row.ref.variantGid, {
            row,
            status: "skipped-deleted",
            failureReason: reason,
            guidance: classified.message,
            failureCode: classified.reason,
          });
          return;
        }

        // Shopify's own words stay in failureReason. Replacing them with our
        // paraphrase would leave support unable to see what Shopify actually said,
        // which is the one thing worth having when a row fails for an unexpected
        // reason. Our guidance rides alongside it.
        results.set(row.ref.variantGid, {
          row,
          status: "failed",
          failureReason: reason,
          guidance: classified.message,
          failureClass: classified.class,
          failureCode: classified.reason,
        });
      });
    } catch (error) {
      const classified = classifyFailure(error);

      const original = error instanceof Error ? error.message : String(error);
      for (const row of group) {
        results.set(row.ref.variantGid, {
          row,
          status: "failed",
          failureReason: original,
          guidance: classified.message,
          failureClass: classified.class,
          failureCode: classified.reason,
        });
      }

      // Auth revoked or plan gate: every remaining product would fail identically.
      // Working through them would burn the rate limit to produce 150,000 copies of
      // the same message, and bury the one row that explains it. Rows not attempted
      // stay PENDING, so a resume after the fix picks them up untouched.
      if (stopsTheRun(classified)) {
        terminalRunFailure = classified.message;
        settled += group.length;
        await onProgress?.(settled, writable.length);
        break;
      }
    }

    settled += group.length;
    await onProgress?.(settled, writable.length);
  }

  await verifyRows(results, { client, budget, verifySampleRate, random, sleep, maxAttempts });

  const all = [...results.values()];
  const verified = all.filter((r) => r.status === "verified").length;
  const failed = all.filter((r) => r.status === "failed").length;
  const unverified = all.filter((r) => r.status === "applied-unverified").length;

  // Clean means every row was read back and confirmed -- not merely "nothing threw".
  // A row we wrote but never verified may or may not have landed, and calling that
  // success is exactly the reporting this product exists not to do. Deleted variants
  // are settled decisions rather than outstanding work, so they do not block it.
  return {
    rows: all,
    verified,
    failed,
    unverified,
    clean: failed === 0 && unverified === 0 && terminalRunFailure === undefined,
    stoppedEarly: terminalRunFailure,
  };
}

/**
 * Reads back a sample of applied rows and compares against what was intended.
 *
 * Sampling rather than reading everything: full verification doubles the API cost of
 * every run, and a 10% sample plus every ambiguous row catches systematic problems.
 * The bulk path gets per-row confirmation free from its result file, so this
 * compromise is confined to the sync path.
 */
async function verifyRows(
  results: Map<string, ExecutedRow>,
  options: {
    client: AdminClient;
    budget: RateLimitBudget;
    verifySampleRate: number;
    random: () => number;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts: number;
  },
): Promise<void> {
  const applied = [...results.values()].filter((r) => r.status === "applied-unverified");
  if (applied.length === 0) return;

  const sampleSize = Math.min(
    applied.length,
    Math.max(1, Math.ceil(applied.length * options.verifySampleRate)),
  );
  const sample = pickSample(applied, sampleSize, options.random);
  const ids = sample.map((r) => r.row.ref.variantGid);

  await options.budget.reserve(10 * ids.length);

  let observed: NodesResponse | undefined;
  try {
    const response = await withRetry(
      () => options.client.request<NodesResponse>(VARIANT_PRICES_QUERY, { ids }),
      isThrottledError,
      { maxAttempts: options.maxAttempts, sleep: options.sleep },
    );
    options.budget.observe(response.extensions?.cost);
    observed = response.data;
  } catch (error) {
    // A failed read-back is not a failed write. Leaving the rows unverified is
    // honest: we changed something and could not confirm it, which the run reports
    // as not-clean rather than pretending either way.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of sample) {
      entry.failureReason = `Applied but verification read failed: ${reason}`;
    }
    return;
  }

  const byId = new Map<string, { price?: string; compareAtPrice?: string | null }>();
  for (const node of observed?.nodes ?? []) {
    if (node?.id) byId.set(node.id, node);
  }

  for (const entry of sample) {
    const node = byId.get(entry.row.ref.variantGid);
    // Shared with the bulk path, so the two cannot disagree about what "verified" means.
    const verdict = readBackVerdict(entry.row.intendedPrice, node?.price);

    if (verdict.ok) {
      entry.status = "verified";
      entry.observedPrice = verdict.observed;
    } else {
      entry.status = "failed";
      entry.failureReason = verdict.reason;
      entry.observedPrice = verdict.observed;
    }
  }
}

/** Extracts the positional index from a Shopify userError field path. */
export function indexFromField(field?: string[] | null): number | undefined {
  if (!field) return undefined;
  for (const part of field) {
    if (/^\d+$/.test(part)) return Number(part);
  }
  return undefined;
}


/** Deterministic-with-injected-random sample, without mutating the input. */
function pickSample<T>(items: T[], size: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < size && pool.length > 0; i++) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}
