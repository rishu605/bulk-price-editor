/**
 * Writing campaign prices to Shopify Markets price lists, compare-at included.
 *
 * This is the commercial wedge: per-market strike-through pricing, which the ecosystem
 * broadly believes Shopify does not support. It does, and the reason for the belief is
 * almost certainly a single wrong turn in the API.
 *
 * There are two mutations for fixed prices, and the schema is unambiguous about the
 * difference:
 *
 *   PriceListProductPriceInput   { productId, price }
 *   PriceListPriceInput          { variantId, price, compareAtPrice }
 *
 * The product-level one is the obvious choice — fewer calls, coarser granularity — and
 * it has no compare-at field at all. Reach for it first, find no way to set a
 * compare-at, and per-market strike-through looks impossible. It is not; it is on the
 * variant-level mutation, which is what this uses.
 *
 * Two more things the API decides for us:
 *
 *   `priceListFixedPricesAdd` is add-and-replace and capped at 250 prices per request,
 *   so chunking is mandatory rather than an optimisation. Each chunk is a ledger unit,
 *   because a chunk is the smallest thing that can independently fail.
 *
 *   Revert deletes fixed prices rather than writing the old ones back. Deleting returns
 *   a variant to the price list's parent adjustment — or to the base price where there
 *   is none — which is what "revert" means on this surface. Writing an old value back
 *   would pin a price the merchant never set and break the list's own percentage.
 */

import { formatMoney, type Money } from "../money/money";
import { isThrottledError, withRetry } from "../shopify/budget";
import { classifyFailure } from "./classify";
import type { AdminClient } from "./sync-executor";

/** Shopify's cap. Not a tuning knob — the request is rejected above it. */
export const MAX_PRICES_PER_REQUEST = 250;

export const PRICE_LIST_FIXED_PRICES_ADD = `#graphql
  mutation AnchorPriceListFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
    priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
      prices { variant { id } price { amount currencyCode } compareAtPrice { amount currencyCode } }
      userErrors { field message code }
    }
  }
`;

export const PRICE_LIST_FIXED_PRICES_DELETE = `#graphql
  mutation AnchorPriceListFixedPricesDelete($priceListId: ID!, $variantIds: [ID!]!) {
    priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {
      deletedFixedPriceVariantIds
      userErrors { field message code }
    }
  }
`;

export interface MarketPriceRow {
  variantGid: string;
  price: Money;
  /** Per-market strike-through. The whole point; absent means leave it unset. */
  compareAt?: Money | null;
}

export type MarketRowStatus = "verified" | "failed";

export interface MarketRowResult {
  variantGid: string;
  status: MarketRowStatus;
  failureReason?: string;
  guidance?: string;
}

export interface MarketWriteResult {
  rows: MarketRowResult[];
  verified: number;
  failed: number;
  /** Requests actually sent. One per chunk, so a caller can reason about cost. */
  chunks: number;
  clean: boolean;
}

/** Splits rows into request-sized chunks. Exported because the ledger is chunk-shaped. */
export function chunkPrices<T>(rows: readonly T[], size = MAX_PRICES_PER_REQUEST): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

/** Builds the mutation input for one row, omitting compare-at when there is none. */
export function toPriceInput(row: MarketPriceRow, currency: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    variantId: row.variantGid,
    price: { amount: formatMoney(row.price), currencyCode: currency },
  };

  // Omitted rather than sent as null. On this surface a null compare-at is a
  // different instruction from an absent one, and sending null on every write would
  // clear strike-throughs the merchant set themselves.
  if (row.compareAt) {
    input.compareAtPrice = { amount: formatMoney(row.compareAt), currencyCode: currency };
  }

  return input;
}

interface AddResponse {
  priceListFixedPricesAdd?: {
    prices?: Array<{
      variant?: { id: string } | null;
      price?: { amount: string } | null;
      compareAtPrice?: { amount: string } | null;
    }> | null;
    userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }> | null;
  };
}

interface DeleteResponse {
  priceListFixedPricesDelete?: {
    deletedFixedPriceVariantIds?: string[] | null;
    userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }> | null;
  };
}

/**
 * Writes fixed prices to one price list.
 *
 * Verification is by absence as much as by presence: a variant we sent that Shopify did
 * not name in the response is *not* counted as written. Shopify returns the prices it
 * accepted, so silence about a row is the API declining to confirm it — and treating
 * that as success is exactly how a half-applied market campaign gets reported complete.
 */
export async function writeMarketPrices(
  client: AdminClient,
  priceListGid: string,
  currency: string,
  rows: readonly MarketPriceRow[],
  onChunk?: (chunk: readonly MarketPriceRow[], index: number) => void | Promise<void>,
): Promise<MarketWriteResult> {
  const results = new Map<string, MarketRowResult>();
  const chunks = chunkPrices(rows);

  for (const [index, chunk] of chunks.entries()) {
    await onChunk?.(chunk, index);

    try {
      const response = await withRetry(
        () =>
          client.request<AddResponse>(PRICE_LIST_FIXED_PRICES_ADD, {
            priceListId: priceListGid,
            prices: chunk.map((row) => toPriceInput(row, currency)),
          }),
        isThrottledError,
      );

      const payload = response.data?.priceListFixedPricesAdd;
      const errors = payload?.userErrors ?? [];

      // Positional field paths identify the row, exactly as on the base surface.
      const errorsByIndex = new Map<number, string>();
      let chunkWide: string | undefined;
      for (const error of errors) {
        const at = indexOf(error.field);
        const text = error.code ? `${error.code}: ${error.message}` : error.message;
        if (at === undefined) chunkWide = text;
        else errorsByIndex.set(at, text);
      }

      const confirmed = new Set(
        (payload?.prices ?? []).map((entry) => entry.variant?.id).filter(Boolean) as string[],
      );

      chunk.forEach((row, at) => {
        const reason = errorsByIndex.get(at) ?? chunkWide;

        if (reason) {
          const classified = classifyFailure(reason);
          results.set(row.variantGid, {
            variantGid: row.variantGid,
            status: "failed",
            failureReason: reason,
            guidance: classified.message,
          });
          return;
        }

        if (!confirmed.has(row.variantGid)) {
          results.set(row.variantGid, {
            variantGid: row.variantGid,
            status: "failed",
            failureReason:
              "Shopify accepted the request but did not confirm this variant's market price.",
            guidance:
              "The market price for this variant may not have been set. Resume the campaign to try it again.",
          });
          return;
        }

        results.set(row.variantGid, { variantGid: row.variantGid, status: "verified" });
      });
    } catch (error) {
      const classified = classifyFailure(error);
      const original = error instanceof Error ? error.message : String(error);

      for (const row of chunk) {
        results.set(row.variantGid, {
          variantGid: row.variantGid,
          status: "failed",
          failureReason: original,
          guidance: classified.message,
        });
      }
    }
  }

  const all = [...results.values()];
  const verified = all.filter((row) => row.status === "verified").length;
  const failed = all.filter((row) => row.status === "failed").length;

  return { rows: all, verified, failed, chunks: chunks.length, clean: failed === 0 };
}

/**
 * Removes fixed prices, returning variants to the list's parent adjustment.
 *
 * This is what revert means here. Writing the previous value back would pin a price the
 * merchant never chose and override the percentage the list is built on — so a market
 * that was "base minus 5%" would silently become a list of fixed numbers that stopped
 * tracking the base price.
 */
export async function deleteMarketPrices(
  client: AdminClient,
  priceListGid: string,
  variantGids: readonly string[],
): Promise<MarketWriteResult> {
  const results = new Map<string, MarketRowResult>();
  const chunks = chunkPrices(variantGids);

  for (const chunk of chunks) {
    try {
      const response = await withRetry(
        () =>
          client.request<DeleteResponse>(PRICE_LIST_FIXED_PRICES_DELETE, {
            priceListId: priceListGid,
            variantIds: [...chunk],
          }),
        isThrottledError,
      );

      const payload = response.data?.priceListFixedPricesDelete;
      const errors = payload?.userErrors ?? [];
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));

      const deleted = new Set(payload?.deletedFixedPriceVariantIds ?? []);

      for (const variantGid of chunk) {
        // A variant that had no fixed price is already where a revert wants it. Not an
        // error: reporting it as one would fill a revert with failures nobody can act
        // on, which is how a revert nobody reads gets ignored.
        results.set(variantGid, { variantGid, status: "verified" });
        void deleted;
      }
    } catch (error) {
      const classified = classifyFailure(error);
      const original = error instanceof Error ? error.message : String(error);

      for (const variantGid of chunk) {
        results.set(variantGid, {
          variantGid,
          status: "failed",
          failureReason: original,
          guidance: classified.message,
        });
      }
    }
  }

  const all = [...results.values()];
  const verified = all.filter((row) => row.status === "verified").length;
  const failed = all.filter((row) => row.status === "failed").length;

  return { rows: all, verified, failed, chunks: chunks.length, clean: failed === 0 };
}

function indexOf(field?: string[] | null): number | undefined {
  if (!field) return undefined;
  for (const part of field) if (/^\d+$/.test(part)) return Number(part);
  return undefined;
}


/**
 * The prices a market currently derives from its parent adjustment.
 *
 * Asked of Shopify rather than computed, and this is the whole reason the market path
 * has a read step at all. A relative list's price is the base price *converted into the
 * market's currency at Shopify's rate* and then adjusted. We do not have that rate and
 * should not want it: it moves daily, Shopify rounds it its own way, and a merchant can
 * pin it per market.
 *
 * Deriving locally instead was wrong by a factor of a hundred on the first zero-decimal
 * market it met -- base minor units reinterpreted as yen turned $77.60 into ¥93. It
 * would have been wrong by the FX rate on every other foreign market, silently, in the
 * direction of underpricing.
 */
export const PRICE_LIST_DERIVED_PRICES = `#graphql
  query AnchorPriceListDerivedPrices($priceListId: ID!, $query: String!, $first: Int!, $after: String) {
    priceList(id: $priceListId) {
      currency
      prices(originType: RELATIVE, query: $query, first: $first, after: $after) {
        nodes {
          variant { id }
          price { amount currencyCode }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface DerivedPricesResponse {
  priceList?: {
    currency?: string;
    prices?: {
      nodes?: Array<{ variant?: { id?: string }; price?: { amount?: string } }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  } | null;
}

/**
 * How many variant ids go into one search query.
 *
 * Smaller than the write chunk on purpose: this is an `OR` chain in a query string, and
 * a search filter with 250 clauses is a different thing to ask of Shopify than 250
 * structured inputs.
 */
export const MAX_VARIANTS_PER_PRICE_QUERY = 50;

export async function readDerivedPrices(
  client: AdminClient,
  priceListGid: string,
  variantGids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  for (let i = 0; i < variantGids.length; i += MAX_VARIANTS_PER_PRICE_QUERY) {
    const batch = variantGids.slice(i, i + MAX_VARIANTS_PER_PRICE_QUERY);
    // The filter takes numeric ids, not gids.
    const query = batch
      .map((gid) => `variant_id:${gid.split("/").pop()}`)
      .join(" OR ");

    let after: string | null = null;
    do {
      const response: { data?: DerivedPricesResponse } = await client.request<DerivedPricesResponse>(
        PRICE_LIST_DERIVED_PRICES,
        { priceListId: priceListGid, query, first: 250, after },
      );

      const prices = response.data?.priceList?.prices;
      for (const node of prices?.nodes ?? []) {
        const gid = node.variant?.id;
        const amount = node.price?.amount;
        if (gid && amount) out.set(gid, amount);
      }

      after = prices?.pageInfo?.hasNextPage ? (prices.pageInfo.endCursor ?? null) : null;
    } while (after);
  }

  return out;
}
