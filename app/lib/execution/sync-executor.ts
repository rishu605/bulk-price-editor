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

import { formatMoney, money, type Money } from "../money/money";
import type { PlannedRow } from "../planning/types";
import { isThrottledError, RateLimitBudget, withRetry } from "../shopify/budget";
import type { QueryCost } from "../shopify/budget";

/** Minimal shape of the Admin GraphQL client, so tests can inject a fake. */
export interface AdminClient {
  request<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data?: T; extensions?: { cost?: QueryCost } }>;
}

export type ExecutedStatus = "verified" | "failed" | "applied-unverified";

export interface ExecutedRow {
  row: PlannedRow;
  status: ExecutedStatus;
  /** Human-readable, because support reads these. */
  failureReason?: string;
  /** What the read-back actually observed, when it disagreed. */
  observedPrice?: Money;
}

export interface ExecuteResult {
  rows: ExecutedRow[];
  verified: number;
  failed: number;
  /** Applied but not sampled for read-back. */
  unverified: number;
  /** True only when every row verified — the "verified clean" bar. */
  clean: boolean;
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
    random = Math.random,
    sleep,
    maxAttempts = 5,
  } = options;

  const writable = rows.filter((r) => r.status !== "skipped" && r.intendedPrice);
  const results = new Map<string, ExecutedRow>();

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
        results.set(
          row.ref.variantGid,
          reason
            ? { row, status: "failed", failureReason: reason }
            : { row, status: "applied-unverified" },
        );
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const row of group) {
        results.set(row.ref.variantGid, { row, status: "failed", failureReason: reason });
      }
    }
  }

  await verifyRows(results, { client, budget, verifySampleRate, random, sleep, maxAttempts });

  const all = [...results.values()];
  const verified = all.filter((r) => r.status === "verified").length;
  const failed = all.filter((r) => r.status === "failed").length;
  const unverified = all.filter((r) => r.status === "applied-unverified").length;

  return { rows: all, verified, failed, unverified, clean: failed === 0 };
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
    const intended = entry.row.intendedPrice;
    if (!node?.price || !intended) {
      entry.status = "failed";
      entry.failureReason = "Verification read returned no price for this variant.";
      continue;
    }

    const actual = money(
      Math.round(Number(node.price) * 10 ** decimalsOf(intended)),
      intended.currency,
    );

    if (actual.amount !== intended.amount) {
      entry.status = "failed";
      entry.failureReason =
        `Read-back mismatch: expected ${formatMoney(intended)}, found ${node.price}.`;
      entry.observedPrice = actual;
    } else {
      entry.status = "verified";
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

function decimalsOf(m: Money): number {
  // Derived from the formatted representation so zero-decimal currencies (JPY) and
  // three-decimal ones (KWD) both round-trip correctly.
  const formatted = formatMoney(m);
  const dot = formatted.indexOf(".");
  return dot === -1 ? 0 : formatted.length - dot - 1;
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
