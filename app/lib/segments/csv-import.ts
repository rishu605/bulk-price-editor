/**
 * Turning a pasted or uploaded list of identifiers into a frozen segment.
 *
 * The whole value of this feature is in what it refuses to do. A merchant uploading
 * 3,000 SKUs to put on sale needs to know, before anything is priced, exactly which
 * rows the app could not place — and a row it *could* place two ways is not a match,
 * it is a question. Guessing between two variants that share a SKU is how the wrong
 * product ends up discounted, and the merchant has no way to find out until a customer
 * tells them.
 *
 * So the outcome has four buckets, not one list: matched, unmatched, ambiguous, and
 * repeated. Only the first becomes the segment.
 */

/**
 * What a value in the file was recognised as.
 *
 * `variant-id` is a bare number in a column headed Variant ID -- how Shopify's own admin
 * and Matrixify write a variant (#774). `barcode` is a bare number anywhere else, which is
 * only *probably* a barcode: it is also tried as a variant id and a SKU.
 */
export type IdentifierKind = "variant-gid" | "variant-id" | "product-gid" | "sku" | "barcode";

/** Header names that say a column holds variant ids. */
export const VARIANT_ID_HEADERS: readonly string[] = ["variant id", "variant_id", "variantid"];

export interface CsvRow {
  /** 1-based line in the original file, so a report points at something findable. */
  line: number;
  value: string;
  /** Set when the column's header says what it holds: a Variant ID column (#774). */
  column?: "variant-id";
}

export interface AmbiguousRow {
  row: CsvRow;
  kind: IdentifierKind;
  /** Every variant the value could mean. Never resolved for the merchant. */
  candidates: string[];
}

export interface MatchOutcome {
  /** Deduped variant gids, in first-seen order. */
  matched: string[];
  /** Values nothing in the catalogue answers to. */
  unmatched: CsvRow[];
  /** Values that match more than one variant. Deliberately not resolved. */
  ambiguous: AmbiguousRow[];
  /** Values listed more than once. Harmless, but worth saying so nobody miscounts. */
  repeated: CsvRow[];
}

/**
 * The catalogue, indexed for lookup.
 *
 * Values map to *lists* of variant gids rather than single ones, because SKUs and
 * barcodes are not unique in practice — merchants reuse them across sizes, and
 * imported catalogues are full of accidental collisions. A `Map<string, string>` here
 * would silently keep whichever row happened to be inserted last, which is precisely
 * the guess this module exists not to make.
 */
export interface MatchIndex {
  byVariantGid: Set<string>;
  byProductGid: Map<string, string[]>;
  bySku: Map<string, string[]>;
  byBarcode: Map<string, string[]>;
}

export function buildMatchIndex(
  variants: ReadonlyArray<{
    variantGid: string;
    productGid: string;
    sku?: string | null;
    barcode?: string | null;
  }>,
): MatchIndex {
  const index: MatchIndex = {
    byVariantGid: new Set(),
    byProductGid: new Map(),
    bySku: new Map(),
    byBarcode: new Map(),
  };

  const push = (map: Map<string, string[]>, key: string | null | undefined, gid: string) => {
    const trimmed = key?.trim();
    if (!trimmed) return;
    const existing = map.get(trimmed.toLowerCase());
    if (existing) existing.push(gid);
    else map.set(trimmed.toLowerCase(), [gid]);
  };

  for (const variant of variants) {
    index.byVariantGid.add(variant.variantGid);
    push(index.byProductGid, variant.productGid, variant.variantGid);
    push(index.bySku, variant.sku, variant.variantGid);
    push(index.byBarcode, variant.barcode, variant.variantGid);
  }

  return index;
}

/**
 * Extracts one identifier per line from CSV text.
 *
 * The first column only, and a header row dropped if it looks like one. Merchants
 * export from a spreadsheet and the file arrives with whatever columns their theme or
 * ERP produced; asking them to strip it down first is a good way to have them not use
 * the feature.
 */
export function parseIdentifierCsv(text: string): { rows: CsvRow[]; skippedHeader: string | null } {
  const lines = text.split(/\r?\n/);
  const rows: CsvRow[] = [];
  let skippedHeader: string | null = null;

  for (const [i, raw] of lines.entries()) {
    const value = firstCell(raw).trim();
    if (!value) continue;

    // A first row that names a column rather than being one. Checked by content, not
    // position: plenty of files have no header, and dropping a real SKU called "sku"
    // is a smaller sin than silently treating a header as a missing product.
    if (rows.length === 0 && skippedHeader === null && isHeaderLabel(value)) {
      skippedHeader = value;
      continue;
    }

    rows.push({ line: i + 1, value });
  }

  // A file headed "Variant ID" says what its numbers are (#774).
  if (skippedHeader && VARIANT_ID_HEADERS.includes(skippedHeader.toLowerCase())) {
    for (const row of rows) row.column = "variant-id";
  }

  return { rows, skippedHeader };
}

const HEADER_LABELS = new Set([
  "sku",
  "skus",
  "variant",
  "variant id",
  "variant_id",
  "variantid",
  "variant gid",
  "gid",
  "id",
  "barcode",
  "handle",
  "product",
  "product id",
]);

function isHeaderLabel(value: string): boolean {
  return HEADER_LABELS.has(value.toLowerCase());
}

/** First CSV cell of a line, honouring quotes so `"Red, large",99` yields one cell. */
export function firstCell(line: string): string {
  if (!line.startsWith('"')) return line.split(",")[0] ?? "";

  let out = "";
  for (let i = 1; i < line.length; i++) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') {
        out += '"';
        i++;
        continue;
      }
      break;
    }
    out += line[i];
  }
  return out;
}

/** Classifies a value without looking it up. */
export function identifierKindOf(value: string, column?: CsvRow["column"]): IdentifierKind {
  if (value.startsWith("gid://shopify/ProductVariant/")) return "variant-gid";
  if (value.startsWith("gid://shopify/Product/")) return "product-gid";
  // A bare number. In a Variant ID column it is a variant id, as Shopify and Matrixify
  // write one -- `46172975661290` -- which used to be read as a barcode and never matched,
  // so a Matrixify export came back "No match" on every row (#774). Anywhere else it is
  // tried as a variant id, a barcode and a SKU, and more than one hit is a question.
  if (/^\d+$/.test(value)) return column === "variant-id" ? "variant-id" : "barcode";
  return "sku";
}

export function matchIdentifiers(rows: readonly CsvRow[], index: MatchIndex): MatchOutcome {
  const matched: string[] = [];
  const seenGid = new Set<string>();
  const seenValue = new Set<string>();

  const unmatched: CsvRow[] = [];
  const ambiguous: AmbiguousRow[] = [];
  const repeated: CsvRow[] = [];

  for (const row of rows) {
    const key = row.value.toLowerCase();
    if (seenValue.has(key)) {
      repeated.push(row);
      continue;
    }
    seenValue.add(key);

    const kind = identifierKindOf(row.value, row.column);
    const candidates = lookup(row.value, kind, index);

    if (candidates.length === 0) {
      unmatched.push(row);
      continue;
    }

    // A product gid legitimately means all of its variants -- that is what the
    // merchant asked for. A SKU or barcode matching several is a collision, and the
    // difference matters: one is an instruction, the other is an unanswered question.
    if (candidates.length > 1 && kind !== "product-gid") {
      ambiguous.push({ row, kind, candidates });
      continue;
    }

    for (const gid of candidates) {
      if (seenGid.has(gid)) continue;
      seenGid.add(gid);
      matched.push(gid);
    }
  }

  return { matched, unmatched, ambiguous, repeated };
}

function lookup(value: string, kind: IdentifierKind, index: MatchIndex): string[] {
  const key = value.trim().toLowerCase();

  switch (kind) {
    case "variant-gid":
      return index.byVariantGid.has(value.trim()) ? [value.trim()] : [];
    case "variant-id": {
      const gid = `gid://shopify/ProductVariant/${value.trim()}`;
      return index.byVariantGid.has(gid) ? [gid] : [];
    }
    case "product-gid":
      return index.byProductGid.get(key) ?? [];
    case "barcode": {
      // A number is only probably a barcode. It may be a variant id or a numeric SKU,
      // and a merchant should not be told their file is unmatched because we guessed
      // the wrong one. Every reading is tried; two that name different variants are a
      // question, reported as ambiguous rather than answered by whichever came first.
      const asVariant = `gid://shopify/ProductVariant/${value.trim()}`;
      return [
        ...new Set([
          ...(index.byVariantGid.has(asVariant) ? [asVariant] : []),
          ...(index.byBarcode.get(key) ?? []),
          ...(index.bySku.get(key) ?? []),
        ]),
      ];
    }
    case "sku":
      return index.bySku.get(key) ?? index.byBarcode.get(key) ?? [];
  }
}
