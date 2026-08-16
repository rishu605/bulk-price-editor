/**
 * JSONL for bulk operations, in both directions.
 *
 * Both are generators over lines rather than arrays of them. A 150K-variant campaign
 * produces a payload too large to hold comfortably in memory, and its result file is
 * larger still — building or parsing either eagerly works fine on a dev store and
 * falls over on the first real customer. That is the specific failure that produces
 * the category's "the app freezes" reviews.
 */

import type { PlannedRow } from "../planning/types";
import { toVariantInput } from "./sync-executor";

/** One line of the upload: the variables for a single `productVariantsBulkUpdate`. */
export interface BulkMutationLine {
  productId: string;
  variants: Array<Record<string, unknown>>;
}

/**
 * Groups rows by product and yields one JSONL line per product.
 *
 * Line order is irrelevant to correctness — results are matched back by variant id,
 * not by position — but it is deterministic anyway, which makes failures
 * reproducible.
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
    yield { productId, variants: group.map(toVariantInput) };
  }
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
  __lineNumber?: number;
  data?: {
    productVariantsBulkUpdate?: {
      productVariants?: Array<{ id: string; price?: string; compareAtPrice?: string | null }>;
      userErrors?: Array<{ field?: string[] | null; message: string; code?: string | null }>;
    };
  };
  /** Present when the whole line failed rather than an individual field. */
  errors?: unknown;
}

export interface VariantOutcome {
  variantGid: string;
  ok: boolean;
  price?: string;
  compareAtPrice?: string | null;
  failureReason?: string;
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
 */
export async function* parseResults(
  lines: AsyncIterable<string>,
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

    if (parsed.errors) {
      yield {
        malformed: raw.slice(0, 200),
        reason: `Line-level error: ${JSON.stringify(parsed.errors).slice(0, 200)}`,
      };
      continue;
    }

    if (!payload) continue;

    const userErrors = payload.userErrors ?? [];

    // Positional field paths identify which variant in the line failed; an error
    // with no index applies to every variant the line touched.
    const errorsByIndex = new Map<number, string>();
    let lineWideError: string | undefined;
    for (const error of userErrors) {
      const index = positionalIndex(error.field);
      const text = error.code ? `${error.code}: ${error.message}` : error.message;
      if (index === undefined) lineWideError = text;
      else errorsByIndex.set(index, text);
    }

    const variants = payload.productVariants ?? [];

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
      };
    }

    if (variants.length === 0 && lineWideError) {
      yield { malformed: raw.slice(0, 200), reason: lineWideError };
    }
  }
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
