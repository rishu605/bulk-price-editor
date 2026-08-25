/**
 * Reading a merchant's own reference prices, one row at a time.
 *
 * This is the feature that answers a competitor's one-star review: a merchant wanted
 * discounts computed against actual MSRP and the app could only work from whatever the
 * storefront happened to show. An imported baseline makes "20% off MSRP" mean exactly
 * that, permanently, however many campaigns have run since.
 *
 * **A bad row must never fail the file.** On five hundred thousand rows, one malformed
 * price should produce one error line, not a rejected import — a merchant who has to
 * find the single bad row in a spreadsheet before anything at all happens is a merchant
 * who gives up. So every row is validated on its own and the failures come back as a
 * list they can fix and re-upload.
 *
 * Validation is deliberately strict about the things that would produce a wrong price
 * and permissive about the things that would not. A price with too many decimals for
 * its currency is refused; a stray column, a header, or a blank line is not.
 */

import { parseMoney, type Money } from "../money/money";

export interface RawRow {
  /** 1-based line in the file, so an error points at something findable. */
  line: number;
  identifier: string;
  price: string;
  compareAt?: string;
  currency?: string;
}

export interface ValidRow extends RawRow {
  parsedPrice: Money;
  parsedCompareAt: Money | null;
}

export type RowProblem =
  | "no-identifier"
  | "no-price"
  | "price-unparseable"
  | "price-not-positive"
  | "compare-at-unparseable"
  | "compare-at-not-above-price";

export interface InvalidRow extends RawRow {
  problem: RowProblem;
  /** Names the row, the cause and the next action, per the error taxonomy. */
  reason: string;
}

const REASONS: Record<RowProblem, string> = {
  "no-identifier": "No SKU, barcode or product ID in the first column — nothing to match on.",
  "no-price": "No price given. Leave the row out rather than leaving the price blank.",
  "price-unparseable":
    "Price is not a plain number. Remove currency symbols and thousands separators — 1299.00, not $1,299.00.",
  "price-not-positive":
    "Price must be above zero. A baseline of zero would make every percentage campaign compute to zero.",
  "compare-at-unparseable": "Compare-at price is not a plain number.",
  "compare-at-not-above-price":
    "Compare-at must be higher than the price, or the storefront shows a strike-through that reads as a price increase.",
};

/**
 * Validates one row.
 *
 * Currency comes from the row where given and from the shop otherwise, because
 * precision is currency-specific: "1200.50" is three decimals too many for JPY and
 * exactly right for USD, and getting that wrong writes a baseline a hundred times off.
 */
export function validateRow(row: RawRow, shopCurrency: string): ValidRow | InvalidRow {
  const fail = (problem: RowProblem): InvalidRow => ({ ...row, problem, reason: REASONS[problem] });

  if (!row.identifier?.trim()) return fail("no-identifier");
  if (!row.price?.trim()) return fail("no-price");

  const currency = (row.currency?.trim() || shopCurrency).toUpperCase();

  let parsedPrice: Money;
  try {
    parsedPrice = parseMoney(row.price.trim(), currency);
  } catch {
    return fail("price-unparseable");
  }

  // Zero is refused as firmly as negative. A zero baseline is not merely odd: every
  // percentage campaign computed from it resolves to zero, so one bad row would put a
  // product on sale for nothing.
  if (parsedPrice.amount <= 0) return fail("price-not-positive");

  let parsedCompareAt: Money | null = null;
  if (row.compareAt?.trim()) {
    try {
      parsedCompareAt = parseMoney(row.compareAt.trim(), currency);
    } catch {
      return fail("compare-at-unparseable");
    }
    if (parsedCompareAt.amount <= parsedPrice.amount) return fail("compare-at-not-above-price");
  }

  return { ...row, parsedPrice, parsedCompareAt };
}

export function isValid(row: ValidRow | InvalidRow): row is ValidRow {
  return "parsedPrice" in row;
}

/** Header names understood for each column, so a merchant's export mostly just works. */
const HEADERS: Record<"identifier" | "price" | "compareAt" | "currency", string[]> = {
  identifier: ["sku", "barcode", "variant", "variant_id", "variantid", "gid", "id", "handle", "product"],
  price: ["price", "baseline", "baseline_price", "msrp", "list_price", "list price", "rrp"],
  compareAt: ["compare_at", "compare at", "compareatprice", "compare_at_price", "was", "was_price"],
  currency: ["currency", "currency_code", "currencycode"],
};

export interface ColumnMap {
  identifier: number;
  price: number;
  compareAt: number | null;
  currency: number | null;
}

/**
 * Works out which column is which from a header row.
 *
 * Merchants export from a spreadsheet or an ERP and the file arrives with whatever
 * columns that produced. Insisting on an exact layout is a good way to have the feature
 * go unused; guessing wrong about which column is the price is a good way to import
 * five hundred thousand wrong baselines, so an unrecognised header means no map and the
 * caller falls back to positional columns it can describe to the merchant.
 */
export function mapColumns(header: readonly string[]): ColumnMap | null {
  const find = (names: string[]) =>
    header.findIndex((cell) => names.includes(cell.trim().toLowerCase()));

  const identifier = find(HEADERS.identifier);
  const price = find(HEADERS.price);
  if (identifier === -1 || price === -1) return null;

  const compareAt = find(HEADERS.compareAt);
  const currency = find(HEADERS.currency);

  return {
    identifier,
    price,
    compareAt: compareAt === -1 ? null : compareAt,
    currency: currency === -1 ? null : currency,
  };
}

/** Splits one CSV line into cells, honouring quotes and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }

  cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * Streams a CSV into raw rows.
 *
 * Line by line, never holding the file: a five-hundred-thousand-row import is tens of
 * megabytes, and the point of an import is that it works on the catalogue the merchant
 * actually has.
 */
export async function* readRows(
  lines: AsyncIterable<string>,
  fallback: ColumnMap = { identifier: 0, price: 1, compareAt: 2, currency: 3 },
): AsyncGenerator<RawRow> {
  let columns: ColumnMap | null = null;
  let lineNumber = 0;

  for await (const raw of lines) {
    lineNumber++;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const cells = splitCsvLine(trimmed);

    if (columns === null) {
      const mapped = mapColumns(cells);
      if (mapped) {
        // That was a header. Consume it rather than importing it as a product.
        columns = mapped;
        continue;
      }
      columns = fallback;
    }

    yield {
      line: lineNumber,
      identifier: cells[columns.identifier] ?? "",
      price: cells[columns.price] ?? "",
      compareAt: columns.compareAt === null ? undefined : cells[columns.compareAt],
      currency: columns.currency === null ? undefined : cells[columns.currency],
    };
  }
}
