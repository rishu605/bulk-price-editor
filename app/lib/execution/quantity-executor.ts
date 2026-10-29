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

import { formatMoney, parseMoney, type Money } from "../money/money";
import { parseLadder, type LadderRung } from "../pricing/ladder-baseline";
import { isThrottledError, withRetry } from "../shopify/budget";
import { classifyFailure } from "./classify";
import { readBackVerdict } from "./read-back";
import type {
  AnchorPriceListQuantityBreaksQuery,
  AnchorPriceListQuantityBreaksQueryVariables,
} from "../../types/admin.generated";

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
 * Reads the ladders back off the price list, for the variants asked about only (#704).
 *
 * The mutation confirms which variants it touched but not what it stored, and this
 * surface is not exempt from the rule the others just learned: "Shopify accepted it" is a
 * claim about the request, not about what a buyer will be charged. A price list rounding
 * rule reshapes a tier without raising a single userError.
 *
 * Filtered by variant, as the market reads are (`readFixedPriceVariants`). It used to walk
 * the whole list's prices, an entry per variant, relative ones included, and stopped after
 * 50 pages of 100: a variant past entry 5,000 had "no ladder", and three wanted variants
 * cost 50 calls. And it could never have run: 100 prices with 20 rungs each is a requested
 * cost near 4,400 points, and Shopify refuses any query over 1,000 before running it. Every
 * read failed, and the callers' catch blocks hid it.
 *
 * The rungs are read a few at a time, with `pageInfo`, so a long ladder is followed to its
 * end rather than cut short: half a ladder recorded as a baseline is a ladder the revert
 * would write back with its top tiers missing. See `ladderReadCost` for the arithmetic.
 */
export const PRICE_LIST_QUANTITY_BREAKS = `#graphql
  query AnchorPriceListQuantityBreaks(
    $id: ID!
    $query: String!
    $first: Int!
    $after: String
    $rungs: Int!
    $rungsAfter: String
  ) {
    priceList(id: $id) {
      prices(query: $query, first: $first, after: $after) {
        nodes {
          variant { id }
          quantityPriceBreaks(first: $rungs, after: $rungsAfter) {
            nodes { minimumQuantity price { amount currencyCode } }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/**
 * How many variants one ladder read asks about.
 *
 * Half the market reads' `MAX_VARIANTS_PER_PRICE_QUERY`, for the bucket rather than the
 * single-query cap: Shopify will not start a query until the bucket holds its whole
 * requested cost, and a smaller one starts sooner after the one before. What a read
 * actually spends -- about five points a variant with no ladder -- is the same either way.
 */
export const LADDER_READ_VARIANTS = 25;

/** Rungs read with each variant. Most ladders are shorter; a longer one is followed. */
const RUNGS_PER_READ = 5;

/** Rungs per follow-up read of one ladder longer than `RUNGS_PER_READ`. */
const RUNGS_PER_FOLLOW_UP = 100;

/**
 * Shopify's requested cost of one ladder read: an object is 1, a connection 2 plus `first`
 * times what each node selects (https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits).
 * Each price is itself, its variant, its rungs' connection (each rung and its price), and
 * the rungs' `pageInfo`; around them, the list and the prices' connection and `pageInfo`.
 */
export function ladderReadCost(variants: number, rungs: number): number {
  return 1 + 2 + variants * (1 + 1 + (2 + rungs * 2) + 1) + 1;
}

/** Shopify refuses a query whose requested cost is over this, whatever the plan. */
export const MAX_SINGLE_QUERY_COST = 1_000;

/** How many ladder reads a capture of these wholesale prices takes, by list. */
export function ladderReadsFor(pricesPerList: Iterable<number>): number {
  let reads = 0;
  for (const prices of pricesPerList) reads += Math.ceil(prices / LADDER_READ_VARIANTS);
  return reads;
}

export interface QuantityRow {
  variantGid: string;
  /**
   * Ascending by quantity, already guardrail-checked by `resolveBreaks`.
   *
   * Empty means "this variant should have no ladder" — which is what recomputing without
   * a campaign yields for a variant that never had one. It is a real instruction rather
   * than a no-op, because the campaign's ladder is there and has to be taken away.
   */
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
        // A row that clears a ladder adds nothing, so the mutation has no variant to name
        // for it. Confirmation cannot speak to it either way; the read-back can, and does.
        if (row.breaks.length === 0) {
          results.set(row.variantGid, { variantGid: row.variantGid, status: "verified" });
          continue;
        }

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
 *
 * `onRead` hears how many of the variants have been asked about, after each read: a
 * recapture in the worker says how far its reads have got, because they come before it
 * writes anything and can take minutes (#1105).
 */
export async function readLadders(
  client: AdminClient,
  priceListGid: string,
  variantGids: readonly string[],
  onRead?: (asked: number) => void | Promise<void>,
): Promise<Map<string, Array<{ minimumQuantity: number; amount: string }>>> {
  const wanted = [...new Set(variantGids)];
  const found = new Map<string, Array<{ minimumQuantity: number; amount: string }>>();
  // Ladders with more rungs than one read carries, and where the read stopped.
  const longer = new Map<string, string>();

  for (let at = 0; at < wanted.length; at += LADDER_READ_VARIANTS) {
    const batch = wanted.slice(at, at + LADDER_READ_VARIANTS);
    const asked = new Set(batch);

    // Every page, however many: a search over 25 variants answers at most 25 prices, but a
    // read that stopped early would call the rest "no ladder", which is the bug this fixes.
    let after: string | null = null;
    do {
      const prices = await readPrices(client, priceListGid, {
        query: variantQuery(batch),
        first: batch.length,
        after,
        rungs: RUNGS_PER_READ,
        rungsAfter: null,
      });

      for (const node of prices?.nodes ?? []) {
        const id = node.variant?.id;
        // The search names these variants, but a node is still checked against them: an
        // answer about a variant nobody asked about is not this read's to record.
        if (!id || !asked.has(id)) continue;
        const rungs = rungsOf(node);
        if (rungs.length > 0) found.set(id, rungs);
        const more = node.quantityPriceBreaks?.pageInfo;
        if (more?.hasNextPage && more.endCursor) longer.set(id, more.endCursor);
      }

      after = prices?.pageInfo?.hasNextPage ? (prices.pageInfo.endCursor ?? null) : null;
    } while (after);
    await onRead?.(at + batch.length);
  }

  // A long ladder, followed to its last rung.
  for (const [variantGid, cursor] of longer) {
    let rungsAfter: string | null = cursor;
    while (rungsAfter) {
      const prices = await readPrices(client, priceListGid, {
        query: variantQuery([variantGid]),
        first: 1,
        after: null,
        rungs: RUNGS_PER_FOLLOW_UP,
        rungsAfter,
      });
      const node = prices?.nodes.find((entry) => entry.variant?.id === variantGid);
      // Read once in full or not at all: a ladder that came back shorter than it was is a
      // claim the revert would act on, so a follow-up that lost the price fails the read.
      if (!node) throw new Error(`The quantity breaks for ${variantGid} could not be read to the end.`);
      found.set(variantGid, [...(found.get(variantGid) ?? []), ...rungsOf(node)]);
      const more = node.quantityPriceBreaks?.pageInfo;
      rungsAfter = more?.hasNextPage ? (more.endCursor ?? null) : null;
    }
  }

  // An empty ladder is left out rather than recorded as an empty one: "no breaks" is the
  // absence of an entry here, and the baseline column says the same with null.
  for (const [variantGid, rungs] of found) {
    found.set(variantGid, [...rungs].sort((a, b) => a.minimumQuantity - b.minimumQuantity));
  }
  return found;
}

type PriceNode = NonNullable<NonNullable<AnchorPriceListQuantityBreaksQuery["priceList"]>["prices"]>["nodes"][number];

async function readPrices(
  client: AdminClient,
  priceListGid: string,
  page: Omit<AnchorPriceListQuantityBreaksQueryVariables, "id">,
) {
  const response: { data?: AnchorPriceListQuantityBreaksQuery } = await withRetry(
    () =>
      client.request<AnchorPriceListQuantityBreaksQuery>(PRICE_LIST_QUANTITY_BREAKS, {
        id: priceListGid,
        ...page,
      } satisfies AnchorPriceListQuantityBreaksQueryVariables),
    isThrottledError,
  );
  return response.data?.priceList?.prices;
}

/** The search filter for these variants. It takes numeric ids, not gids. */
function variantQuery(variantGids: readonly string[]): string {
  return variantGids.map((gid) => `variant_id:${gid.split("/").pop()}`).join(" OR ");
}

function rungsOf(node: PriceNode): Array<{ minimumQuantity: number; amount: string }> {
  return (node.quantityPriceBreaks?.nodes ?? []).map((tier) => ({
    minimumQuantity: tier.minimumQuantity,
    amount: tier.price.amount,
  }));
}

/**
 * The ladders a catalogue holds now, as a baseline records them: integer minor units of
 * `currency`, and a ladder that does not parse left out, which is "no ladder".
 *
 * One reading for every capture that records a wholesale baseline -- the campaign's, before
 * it writes, and the catalogue sync's (#1071) -- so the two cannot record the same ladder
 * differently. Throws when Shopify cannot be read: what an unread ladder means is the
 * caller's to decide. `onRead` as `readLadders`.
 */
export async function readBaselineLadders(
  client: AdminClient,
  priceListGid: string,
  currency: string,
  variantGids: readonly string[],
  onRead?: (asked: number) => void | Promise<void>,
): Promise<Map<string, LadderRung[]>> {
  if (variantGids.length === 0) return new Map();

  const ladders = new Map<string, LadderRung[]>();
  for (const [variantGid, rungs] of await readLadders(client, priceListGid, variantGids, onRead)) {
    const parsed = parseLadder(
      rungs.map((rung) => ({ minimumQuantity: rung.minimumQuantity, amount: parseMoney(rung.amount, currency).amount })),
      currency,
    );
    if (parsed) ladders.set(variantGid, parsed);
  }
  return ladders;
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

    // Clearing a ladder succeeds by the ladder being gone. `readLadders` omits a variant
    // with no rungs, so absence is exactly the outcome asked for.
    if (row.breaks.length === 0) {
      if (actual && actual.length > 0) {
        results.set(row.variantGid, {
          variantGid: row.variantGid,
          status: "failed",
          failureReason: `Read-back mismatch: asked for no quantity breaks, the price list still holds ${actual.length}.`,
          guidance: "The old ladder is still live for this product. Resume the revert to clear it.",
        });
      }
      continue;
    }

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


