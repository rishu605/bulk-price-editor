/**
 * JSONL for bulk operations, in both directions.
 *
 * Both are generators over lines rather than arrays of them. A 150K-variant campaign
 * produces a payload too large to hold comfortably in memory, and its result file is
 * larger still — building or parsing either eagerly works fine on a dev store and
 * falls over on the first real customer. That is the specific failure that produces
 * the category's "the app freezes" reviews.
 */

import { chunk } from "../db/chunk";
import type { PlannedRow } from "../planning/types";
import { INPUT_ARRAY_MAX, toVariantInput } from "./sync-executor";

/** One line of the upload: the variables for a single `productVariantsBulkUpdate`. */
export interface BulkMutationLine {
  productId: string;
  variants: Array<Record<string, unknown>>;
}

/**
 * Groups rows by product and yields one JSONL line per product -- or several, for a
 * product with more than `INPUT_ARRAY_MAX` variants in scope.
 *
 * Each line is one `productVariantsBulkUpdate`, and that mutation refuses an input array
 * over 250. A product can have 2,048 variants. One line per product put all of a large
 * product's variants in a single array: Shopify would refuse the line, every variant on it
 * would fail, and a resume would build the same line and fail the same way (#985, the
 * bulk half of #847). So a product is split at the cap here, as the sync path splits its
 * requests, and each line is its own unit of success or failure.
 *
 * Line order is irrelevant to correctness -- results are matched back by `__lineNumber`
 * against `layoutOf`, never by position in the file -- but it is deterministic anyway,
 * which makes failures reproducible.
 */
export function* buildMutationLines(
  rows: Iterable<PlannedRow>,
  productOf: (variantGid: string) => string,
): Generator<BulkMutationLine> {
  const byProduct = new Map<string, PlannedRow[]>();

  for (const row of rows) {
    if (row.status === "skipped" || !row.intendedPrice) continue;
    const product = productOf(row.ref.variantGid);
    const group = byProduct.get(product);
    if (group) group.push(row);
    else byProduct.set(product, [row]);
  }

  for (const [productId, group] of byProduct) {
    for (const part of chunk(group, INPUT_ARRAY_MAX)) {
      yield { productId, variants: part.map(toVariantInput) };
    }
  }
}

/**
 * What each line of an upload carried: its variants' ids, in the order the line sent
 * them. `layout[n]` is the line Shopify's result file calls `"__lineNumber": n`, counted
 * from zero as Shopify counts them.
 *
 * A userError's field path (`["variants", "3", "price"]`) indexes the array of the line
 * it came from. Once a product spans several lines that is not the product's own order,
 * and the result line's `productVariants` cannot stand in for it either: it may leave out
 * the variant that failed, and then every index after it names the next variant along.
 * Only what was sent can say whose error it is (#985).
 */
export type LineLayout = ReadonlyArray<ReadonlyArray<string>>;

export function layoutOf(lines: Iterable<BulkMutationLine>): string[][] {
  return [...lines].map((line) => line.variants.map((input) => String(input.id)));
}

/** Serialises lines to JSONL text. Yields strings so the caller can stream them. */
export function* serializeJsonl(lines: Iterable<BulkMutationLine>): Generator<string> {
  for (const line of lines) yield `${JSON.stringify(line)}\n`;
}

// ------------------------------------------------------------------- results

/**
 * A parsed result line.
 *
 * Shopify emits one JSON object per line of the original upload, carrying the
 * mutation payload and a `__lineNumber` pointing back at the request line.
 */
export interface BulkResultLine {
  /** The upload line this answers, counted from zero. */
  __lineNumber?: number;
  data?: {
    productVariantsBulkUpdate?: {
      product?: { updatedAt?: string | null } | null;
      productVariants?: ReportedVariant[] | null;
      userErrors?: ResultUserError[];
    };
  };
  /** Present when the whole line failed rather than an individual field. */
  errors?: unknown;
}

interface ReportedVariant {
  id: string;
  price?: string;
  compareAtPrice?: string | null;
}

interface ResultUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface VariantOutcome {
  variantGid: string;
  ok: boolean;
  price?: string;
  compareAtPrice?: string | null;
  failureReason?: string;
  /** The product's `updatedAt` after this line's write: Shopify's clock, to the second (#932). */
  remoteUpdatedAt?: string;
}

/**
 * Splits a byte/text stream into lines without buffering the whole thing.
 *
 * Handles a final line with no trailing newline, and tolerates \r\n.
 */
export async function* streamLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      if (line.length > 0) yield line;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}

/**
 * Turns result lines into per-variant outcomes.
 *
 * A malformed line is reported rather than thrown: one unparseable line must not
 * discard the results for every other row in a 150K-row run. The affected rows stay
 * unverified and get retried, which is the safe direction.
 *
 * With the upload's `layout`, a line's errors are read against the variants that line
 * sent: a userError names the variant at its index in that line, and an error for the
 * whole line fails exactly the variants it carried -- never another line's, and never the
 * neighbour of the one that failed (#985). Without it -- settling an operation another
 * process submitted, which never held the layout -- a line can only be read against the
 * variants it reports, as before.
 */
export async function* parseResults(
  lines: AsyncIterable<string>,
  layout?: LineLayout,
): AsyncGenerator<VariantOutcome | { malformed: string; reason: string }> {
  for await (const raw of lines) {
    let parsed: BulkResultLine;
    try {
      parsed = JSON.parse(raw) as BulkResultLine;
    } catch (error) {
      yield {
        malformed: raw.slice(0, 200),
        reason: error instanceof Error ? error.message : String(error),
      };
      continue;
    }

    const payload = parsed.data?.productVariantsBulkUpdate;
    const sent = sentOn(parsed, layout);

    if (parsed.errors) {
      const reason = `Line-level error: ${JSON.stringify(parsed.errors).slice(0, 200)}`;
      // Shopify ran nothing on this line. Knowing what it carried, that is a failure of
      // exactly those variants, with Shopify's reason. Not knowing, it is reported, and
      // its variants stay unreported: unverified, retried by a resume.
      if (sent) {
        for (const variantGid of sent) yield { variantGid, ok: false, failureReason: reason };
      } else {
        yield { malformed: raw.slice(0, 200), reason };
      }
      continue;
    }

    if (!payload) continue;

    const userErrors = payload.userErrors ?? [];
    const variants = payload.productVariants ?? [];
    const remoteUpdatedAt = payload.product?.updatedAt ?? undefined;

    if (sent && reportsOnly(variants, sent)) {
      yield* outcomesFor(sent, variants, userErrors, remoteUpdatedAt);
      continue;
    }

    // Positional field paths identify which variant in the line failed; an error
    // with no index applies to every variant the line touched.
    const errorsByIndex = new Map<number, string>();
    let lineWideError: string | undefined;
    for (const error of userErrors) {
      const index = positionalIndex(error.field);
      const text = errorText(error);
      if (index === undefined) lineWideError = text;
      else errorsByIndex.set(index, text);
    }

    // A line-wide failure returns no variants, so there is nothing to key outcomes
    // on. The caller reconciles by absence: any row it sent but never heard about
    // stays unverified rather than being assumed successful.
    // A plain loop, not forEach: `yield` only works in the generator's own body,
    // never inside a callback.
    for (const [index, variant] of variants.entries()) {
      const reason = errorsByIndex.get(index) ?? lineWideError;
      yield {
        variantGid: variant.id,
        ok: !reason,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        failureReason: reason,
        remoteUpdatedAt,
      };
    }

    if (variants.length === 0 && lineWideError) {
      yield { malformed: raw.slice(0, 200), reason: lineWideError };
    }
  }
}

/** The variants a result line's own upload line carried, when the layout can say. */
function sentOn(parsed: BulkResultLine, layout: LineLayout | undefined): ReadonlyArray<string> | undefined {
  const line = parsed.__lineNumber;
  if (!layout || typeof line !== "number" || !Number.isInteger(line) || line < 0) return undefined;
  return layout[line];
}

/**
 * Whether the result line reports only variants its upload line sent.
 *
 * A check on the layout as much as on Shopify: if `__lineNumber` were counted from one
 * rather than zero, or the layout were built from rows in another order, a line's errors
 * would land on a different line's variants. A line that reports a variant it never sent
 * is read the old way instead, against the variants it reports.
 */
function reportsOnly(variants: ReportedVariant[], sent: ReadonlyArray<string>): boolean {
  if (variants.length === 0) return true;
  const carried = new Set(sent);
  return variants.every((variant) => carried.has(variant.id));
}

/**
 * One outcome per variant the line sent, Shopify's word on it where there is one.
 *
 * A userError names the variant at its index in this line. One with no index, or an index
 * the line did not have, is the whole line's. A variant with neither an error nor a place
 * in `productVariants` yields nothing, and the caller reconciles it by absence: written or
 * not, nobody said, so it stays unverified rather than being assumed either way.
 */
function* outcomesFor(
  sent: ReadonlyArray<string>,
  variants: ReportedVariant[],
  userErrors: ResultUserError[],
  remoteUpdatedAt: string | undefined,
): Generator<VariantOutcome> {
  const errorsByIndex = new Map<number, string>();
  let lineWideError: string | undefined;
  for (const error of userErrors) {
    const index = positionalIndex(error.field);
    if (index === undefined || index >= sent.length) lineWideError = errorText(error);
    else errorsByIndex.set(index, errorText(error));
  }

  const reported = new Map(variants.map((variant) => [variant.id, variant]));
  for (const [index, variantGid] of sent.entries()) {
    const reason = errorsByIndex.get(index) ?? lineWideError;
    const variant = reported.get(variantGid);
    if (!reason && !variant) continue;
    yield {
      variantGid,
      ok: !reason,
      price: variant?.price,
      compareAtPrice: variant?.compareAtPrice,
      failureReason: reason,
      remoteUpdatedAt,
    };
  }
}

function errorText(error: ResultUserError): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

function positionalIndex(field?: string[] | null): number | undefined {
  if (!field) return undefined;
  for (const part of field) {
    if (/^\d+$/.test(part)) return Number(part);
  }
  return undefined;
}

/** Convenience for tests and small payloads: collect an async iterable. */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/** Wraps a string as a single-chunk async iterable. */
export async function* fromString(text: string): AsyncGenerator<string> {
  yield text;
}
