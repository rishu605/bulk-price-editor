/**
 * Writing quantity price breaks to a wholesale catalogue.
 *
 * `quantityPricingByVariantUpdate` executes its deletes before its creates and applies
 * **nothing** if any part fails. That is unusually convenient: the request boundary is
 * already a transaction, so one chunk is one ledger unit and there is no such thing as a
 * half-written ladder. It also means a chunk cannot be retried row by row — the whole
 * chunk succeeded or none of it did, and the ledger has to say so.
 *
 * Replacing rather than appending is deliberate. A campaign owns the ladder it writes, so
 * every run deletes the variant's existing breaks in the same request that creates the
 * new ones. Appending would leave last month's 12+ tier sitting under this month's, and
 * a buyer would get whichever Shopify preferred.
 */

import { formatMoney, type Money } from "../money/money";
import { isThrottledError, withRetry } from "../shopify/budget";
import { classifyFailure } from "./classify";
import { readBackVerdict } from "./read-back";

export const QUANTITY_PRICING_UPDATE = `#graphql
  mutation AnchorQuantityPricingUpdate($priceListId: ID!, $input: QuantityPricingByVariantUpdateInput!) {
    quantityPricingByVariantUpdate(priceListId: $priceListId, input: $input) {
      productVariants { id }
      userErrors { field message code }
    }
  }
`;

/** Shopify caps a single quantity-pricing request; chunking keeps one request one unit. */
export const MAX_VARIANTS_PER_QUANTITY_REQUEST = 100;

/**
 * Reads the ladders back off the price list.
 *
 * The mutation confirms which variants it touched but not what it stored, and this
 * surface is not exempt from the rule the others just learned: "Shopify accepted it" is a
 * claim about the request, not about what a buyer will be charged. A price list rounding
 * rule reshapes a tier without raising a single userError.
 */
export const PRICE_LIST_QUANTITY_BREAKS = `#graphql
  query AnchorPriceListQuantityBreaks($priceListId: ID!, $after: String) {
    priceList(id: $priceListId) {
      prices(first: 100, after: $after) {
        nodes {
          variant { id }
          quantityPriceBreaks(first: 20) {
            nodes { minimumQuantity price { amount currencyCode } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export interface QuantityRow {
  variantGid: string;
  /** Ascending by quantity, already guardrail-checked by `resolveBreaks`. */
  breaks: Array<{ minimumQuantity: number; price: Money }>;
}

export interface QuantityRowResult {
  variantGid: string;
  status: "verified" | "failed";
  failureReason?: string;
  guidance?: string;
}

export interface QuantityWriteResult {
  rows: QuantityRowResult[];
  verified: number;
  failed: number;
  /** Requests sent. One per chunk, and one chunk is one transaction. */
  chunks: number;
  clean: boolean;
}

interface AdminClient {
  request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data?: T; extensions?: unknown }>;
}

interface UpdateResponse {
  quantityPricingByVariantUpdate?: {
    productVariants?: Array<{ id: string } | null> | null;
    userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }> | null;
  };
}

export function chunkQuantityRows(
  rows: readonly QuantityRow[],
  size = MAX_VARIANTS_PER_QUANTITY_REQUEST,
): QuantityRow[][] {
  const chunks: QuantityRow[][] = [];
  for (let at = 0; at < rows.length; at += size) chunks.push(rows.slice(at, at + size));
  return chunks;
}

/**
 * Writes ladders, one transaction per chunk.
 *
 * Every row in a failing chunk is reported failed, including the ones Shopify did not
 * complain about. That is not pessimism: the mutation applied nothing, so calling any of
 * them verified would be recording a price that is not there.
 */
export async function writeQuantityBreaks(
  client: AdminClient,
  priceListGid: string,
  rows: readonly QuantityRow[],
  onChunk?: (chunk: QuantityRow[], index: number) => Promise<void> | void,
): Promise<QuantityWriteResult> {
  const results = new Map<string, QuantityRowResult>();
  const chunks = chunkQuantityRows(rows);

  for (const [index, chunk] of chunks.entries()) {
    await onChunk?.(chunk, index);

    const failChunk = (reason: string, guidance: string) => {
      for (const row of chunk) {
        results.set(row.variantGid, {
          variantGid: row.variantGid,
          status: "failed",
          failureReason: reason,
          guidance,
        });
      }
    };

    try {
      const response = await withRetry(
        () =>
          client.request<UpdateResponse>(QUANTITY_PRICING_UPDATE, {
            priceListId: priceListGid,
            input: toInput(chunk),
          }),
        isThrottledError,
      );

      const payload = response.data?.quantityPricingByVariantUpdate;
      const errors = payload?.userErrors ?? [];

      if (errors.length > 0) {
        // No positional mapping here, unlike the other surfaces: the mutation is
        // all-or-nothing, so attributing the failure to one row would imply the others
        // landed. They did not.
        const said = errors
          .map((error) => (error.code ? `${error.code}: ${error.message}` : error.message))
          .join("; ");

        failChunk(
          said,
          `Shopify rejected this batch of quantity breaks and applied none of it, so all ${chunk.length} products in it are unchanged. Fix the reported problem and resume.`,
        );
        continue;
      }

      const confirmed = new Set(
        (payload?.productVariants ?? []).map((variant) => variant?.id).filter(Boolean) as string[],
      );

      for (const row of chunk) {
        if (!confirmed.has(row.variantGid)) {
          results.set(row.variantGid, {
            variantGid: row.variantGid,
            status: "failed",
            failureReason: "Shopify accepted the batch but did not confirm this variant.",
            guidance:
              "The quantity breaks for this product may not have been set. Resume the campaign to try it again.",
          });
          continue;
        }

        results.set(row.variantGid, { variantGid: row.variantGid, status: "verified" });
      }
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error);
      failChunk(original, classifyFailure(error).message);
    }
  }

  await verifyLadders(client, priceListGid, rows, results);

  const all = [...results.values()];
  const verified = all.filter((row) => row.status === "verified").length;
  const failed = all.filter((row) => row.status === "failed").length;

  return { rows: all, verified, failed, chunks: chunks.length, clean: failed === 0 };
}

/**
 * Compares every ladder we believe we wrote against the one the price list holds.
 *
 * A failed read leaves rows verified-by-confirmation rather than downgrading them: the
 * mutation is atomic and did report success, so "we could not check" is a weaker claim
 * than "it is wrong" and should not be reported as the latter. It is recorded on the row
 * so a run is not silently less verified than it looks.
 */
/**
 * The ladders a price list currently holds, for the variants asked about.
 *
 * Used twice, for opposite reasons: to verify what a run just wrote, and to capture what
 * a catalogue had *before* a campaign touched it. Same read, because a ladder observed
 * after the write and a ladder observed before it are the same kind of fact.
 */
export async function readLadders(
  client: AdminClient,
  priceListGid: string,
  variantGids: readonly string[],
): Promise<Map<string, Array<{ minimumQuantity: number; amount: string }>>> {
  const wanted = new Set(variantGids);
  const found = new Map<string, Array<{ minimumQuantity: number; amount: string }>>();

  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const response: { data?: BreaksResponse } = await withRetry(
      () => client.request<BreaksResponse>(PRICE_LIST_QUANTITY_BREAKS, { priceListId: priceListGid, after }),
      isThrottledError,
    );

    const prices = response.data?.priceList?.prices;
    for (const node of prices?.nodes ?? []) {
      const id = node?.variant?.id;
      if (!id || !wanted.has(id)) continue;

      const rungs = (node.quantityPriceBreaks?.nodes ?? [])
        .filter(Boolean)
        .map((tier) => ({ minimumQuantity: tier!.minimumQuantity, amount: tier!.price.amount }))
        .sort((a, b) => a.minimumQuantity - b.minimumQuantity);

      // An empty ladder is left out rather than recorded as an empty one: "no breaks" is
      // the absence of a row here, and the baseline column says the same with null.
      if (rungs.length > 0) found.set(id, rungs);
    }

    if (!prices?.pageInfo?.hasNextPage) break;
    after = prices.pageInfo.endCursor ?? null;
  }

  return found;
}

async function verifyLadders(
  client: AdminClient,
  priceListGid: string,
  rows: readonly QuantityRow[],
  results: Map<string, QuantityRowResult>,
): Promise<void> {
  let seen: Map<string, Array<{ minimumQuantity: number; amount: string }>>;
  try {
    seen = await readLadders(client, priceListGid, rows.map((row) => row.variantGid));
  } catch {
    // Unreadable is not the same as wrong: the mutation is atomic and did report success,
    // so downgrading these rows would send a merchant hunting a problem that may not exist.
    return;
  }

  for (const row of rows) {
    const current = results.get(row.variantGid);
    if (!current || current.status !== "verified") continue;

    const actual = seen.get(row.variantGid);
    if (!actual) {
      results.set(row.variantGid, {
        variantGid: row.variantGid,
        status: "failed",
        failureReason: "The price list holds no quantity breaks for this variant after the write.",
        guidance: "The ladder did not stick. Resume the campaign to write it again.",
      });
      continue;
    }

    const mismatch = compareLadder(row, actual);
    if (mismatch) {
      results.set(row.variantGid, {
        variantGid: row.variantGid,
        status: "failed",
        failureReason: mismatch,
        guidance:
          "Shopify stored a different wholesale ladder than the campaign asked for. Check the price list for rounding or adjustment rules, then resume.",
      });
    }
  }
}

/** The first rung that disagrees, in words, or null when the ladder matches. */
function compareLadder(
  row: QuantityRow,
  actual: ReadonlyArray<{ minimumQuantity: number; amount: string }>,
): string | null {
  if (actual.length !== row.breaks.length) {
    return `Read-back mismatch: wrote ${row.breaks.length} quantity breaks, the price list holds ${actual.length}.`;
  }

  for (const [index, tier] of row.breaks.entries()) {
    const stored = actual[index]!;

    if (stored.minimumQuantity !== tier.minimumQuantity) {
      return `Read-back mismatch: expected a break at ${tier.minimumQuantity}+, found one at ${stored.minimumQuantity}+.`;
    }

    const verdict = readBackVerdict(tier.price, stored.amount);
    if (!verdict.ok) return `At ${tier.minimumQuantity}+ — ${verdict.reason}`;
  }

  return null;
}

interface BreaksResponse {
  priceList?: {
    prices?: {
      nodes?: Array<{
        variant?: { id: string } | null;
        quantityPriceBreaks?: {
          nodes?: Array<{ minimumQuantity: number; price: { amount: string } } | null> | null;
        } | null;
      } | null> | null;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    } | null;
  } | null;
}

/**
 * One chunk as the mutation's input.
 *
 * The deletes are what make a run idempotent: the campaign owns this variant's ladder, so
 * whatever is there is replaced rather than added to.
 */
function toInput(chunk: readonly QuantityRow[]) {
  return {
    pricesToAdd: [],
    pricesToDeleteByVariantId: [],
    quantityPriceBreaksToDeleteByVariantId: chunk.map((row) => row.variantGid),
    quantityPriceBreaksToAdd: chunk.flatMap((row) =>
      row.breaks.map((tier) => ({
        variantId: row.variantGid,
        minimumQuantity: tier.minimumQuantity,
        price: { amount: formatMoney(tier.price), currencyCode: tier.price.currency },
      })),
    ),
    quantityRulesToAdd: [],
    quantityRulesToDeleteByVariantId: [],
  };
}


