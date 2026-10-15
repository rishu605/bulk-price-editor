/**
 * Row-level validation, and the rule that one bad row never fails the file.
 *
 * On five hundred thousand rows, a malformed price should cost that row and nothing
 * else. A merchant who has to find the single bad line in a spreadsheet before anything
 * at all happens is a merchant who gives up on the import — and the import is the
 * feature that lets "20% off MSRP" mean what it says.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import {
  isValid,
  mapColumns,
  readRows,
  splitCsvLine,
  validateRow,
  type InvalidRow,
  type RawRow,
  HANDLE_REFUSAL,
  duplicateRefusal,
  firstRows,
  identifierRefusal,
} from "./csv-rows";

const row = (over: Partial<RawRow> = {}): RawRow => ({
  line: 2,
  identifier: "SKU-1",
  price: "19.99",
  ...over,
});

const check = (over: Partial<RawRow> = {}, currency = "USD") => validateRow(row(over), currency);
const problemOf = (r: ReturnType<typeof validateRow>) => (r as InvalidRow).problem;

describe("validateRow", () => {
  it("parses a good row into integer minor units", () => {
    const result = check();
    if (!isValid(result)) throw new Error("expected valid");
    expect(result.parsedPrice).toEqual(money(1_999, "USD"));
    expect(result.parsedCompareAt).toBeNull();
  });

  it("rejects a price that is not a plain number, and says how to fix it", () => {
    const result = check({ price: "$1,299.00" });
    expect(problemOf(result)).toBe("price-unparseable");
    expect((result as InvalidRow).reason).toContain("1299.00");
  });

  it("refuses zero as firmly as negative", () => {
    // Not merely odd: every percentage campaign computed from a zero baseline resolves
    // to zero, so one bad row would put a product on sale for nothing.
    expect(problemOf(check({ price: "0" }))).toBe("price-not-positive");
    expect(problemOf(check({ price: "0.00" }))).toBe("price-not-positive");
    expect(problemOf(check({ price: "-5.00" }))).toBe("price-not-positive");
  });

  it("requires compare-at to be above the price", () => {
    // Below or equal, the storefront shows a strike-through that reads as an increase.
    expect(problemOf(check({ compareAt: "19.99" }))).toBe("compare-at-not-above-price");
    expect(problemOf(check({ compareAt: "9.99" }))).toBe("compare-at-not-above-price");

    const ok = check({ compareAt: "29.99" });
    if (!isValid(ok)) throw new Error("expected valid");
    expect(ok.parsedCompareAt).toEqual(money(2_999, "USD"));
  });

  it("honours the currency's precision, per row", () => {
    // "1200.50" is two decimals too many for JPY and exactly right for USD. Getting
    // this wrong writes a baseline a hundred times off.
    expect(problemOf(check({ price: "1200.50" }, "JPY"))).toBe("price-unparseable");

    const yen = check({ price: "1200" }, "JPY");
    if (!isValid(yen)) throw new Error("expected valid");
    expect(yen.parsedPrice).toEqual(money(1_200, "JPY"));
  });

  it("refuses a row in another currency rather than writing it unconverted (#734)", () => {
    // `TEE-S,2500,,JPY` on a USD shop was a JPY 2,500 baseline on a USD variant, and a
    // 20%-off campaign wrote $2,000.00 on a $20 T-shirt.
    const result = check({ price: "2500", currency: "JPY" }, "USD");
    expect(isValid(result)).toBe(false);
    if (!isValid(result)) {
      expect(result.problem).toBe("currency-not-shop");
      expect(result.reason).toMatch(/in JPY, but base prices on this store are in USD/);
      expect(result.reason).toMatch(/leave the currency column empty/);
    }
  });

  it("accepts a currency column that agrees with the store, and reads precision from it", () => {
    const yen = check({ price: "1200", currency: "jpy" }, "JPY");
    if (!isValid(yen)) throw new Error("expected valid");
    expect(yen.parsedPrice).toEqual({ amount: 1200, currency: "JPY" });
  });

  it("names the row and the next action for every problem", () => {
    for (const bad of [
      check({ identifier: "" }),
      check({ price: "" }),
      check({ price: "abc" }),
      check({ price: "0" }),
      check({ compareAt: "abc" }),
      check({ compareAt: "1.00" }),
    ]) {
      expect(isValid(bad)).toBe(false);
      expect((bad as InvalidRow).reason.length).toBeGreaterThan(30);
      expect((bad as InvalidRow).line).toBe(2);
    }
  });
});

describe("splitCsvLine", () => {
  it("honours quotes and doubled quotes", () => {
    expect(splitCsvLine('SKU-1,"Red, large",19.99')).toEqual(["SKU-1", "Red, large", "19.99"]);
    expect(splitCsvLine('"24"" monitor",99')).toEqual(['24" monitor', "99"]);
  });
});

describe("mapColumns", () => {
  it("finds columns by any of their common names", () => {
    expect(mapColumns(["SKU", "MSRP", "was_price"])).toEqual({
      identifier: 0,
      price: 1,
      compareAt: 2,
      currency: null,
      cost: null,
    });
  });

  it("reads a Matrixify export untouched", () => {
    // Matrixify is how a large share of Shopify merchants already move catalogue data.
    // Its headers are title-case and multi-word, which lowercase to strings none of the
    // single-word aliases matched — so a merchant with a working spreadsheet workflow
    // hit "unrecognised header" and went back to doing it by hand.
    expect(
      mapColumns([
        "Handle",
        "Variant SKU",
        "Variant Price",
        "Variant Compare At Price",
        "Variant Cost",
      ]),
      // Identifier is the SKU at index 1, not the Handle at index 0. Matrixify puts
      // Handle first, and a handle names a product where a SKU names a variant.
    ).toEqual({ identifier: 1, price: 2, compareAt: 3, currency: null, cost: 4 });
  });

  it("reads a real Matrixify export's header row, keyed by its Variant ID (#774)", () => {
    // The columns a Matrixify Products export actually carries. "ID" is the *product*;
    // "Variant ID" is the variant, written as a plain number -- and it is the most
    // specific identifier, so it is the one used, with the column saying what it holds.
    expect(
      mapColumns([
        "ID", "Handle", "Variant ID", "Variant SKU", "Variant Barcode",
        "Variant Price", "Variant Compare At Price", "Variant Cost",
      ]),
    ).toEqual({ identifier: 2, identifierColumn: "variant-id", price: 5, compareAt: 6, currency: null, cost: 7 });
  });

  it("prefers the SKU column over a handle, whichever comes first", () => {
    // Both orderings, because the bug this replaces was "whichever column appeared
    // first wins" and it only shows up when the handle is on the left.
    expect(mapColumns(["Variant SKU", "Handle", "Variant Price"])?.identifier).toBe(0);
    expect(mapColumns(["Handle", "Variant SKU", "Variant Price"])?.identifier).toBe(1);
  });

  it("recognises a handle when that is the only identifier there is, and says it names a product (#735)", () => {
    // Recognised, so the file is not read by position; marked, so each row is refused with
    // the reason -- a handle names a product, and was looked up as a SKU that never matched.
    expect(mapColumns(["Handle", "Variant Price"])).toMatchObject({ identifier: 0, identifierColumn: "handle" });
    expect(mapColumns(["Product", "Price"])).toMatchObject({ identifier: 0, identifierColumn: "handle" });
    expect(identifierRefusal({ identifierColumn: "handle" })).toBe(HANDLE_REFUSAL);
    expect(identifierRefusal({ identifierColumn: "variant-id" })).toBeNull();
    expect(identifierRefusal({})).toBeNull();
  });

  it("reads a Shopify product export's header row by its Variant SKU (#735)", () => {
    // Verbatim from Shopify admin -> Products -> Export. No Variant ID column; Handle first.
    const header = [
      "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
      "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
      "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty",
      "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price",
      "Variant Requires Shipping", "Variant Taxable", "Variant Barcode", "Image Src", "Image Position",
      "Image Alt Text", "Gift Card", "SEO Title", "SEO Description", "Variant Image", "Variant Weight Unit",
      "Variant Tax Code", "Cost per item", "Status",
    ];
    expect(mapColumns(header)).toEqual({ identifier: 14, price: 20, compareAt: 21, currency: null, cost: 34 });
  });

  it("returns null when it cannot tell which column is the price", () => {
    // Guessing wrong here imports five hundred thousand wrong baselines. No map means
    // the caller falls back to positions it can describe to the merchant.
    expect(mapColumns(["a", "b", "c"])).toBeNull();
    expect(mapColumns(["sku", "title", "vendor"])).toBeNull();
  });
});

describe("readRows", () => {
  async function* lines(...items: string[]) {
    for (const item of items) yield item;
  }
  const collect = async (source: AsyncIterable<string>) => {
    const out = [];
    for await (const r of readRows(source)) out.push(r);
    return out;
  };

  it("consumes a recognised header rather than importing it", () => {
    return collect(lines("sku,price", "SKU-1,10.00")).then((rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ line: 2, identifier: "SKU-1", price: "10.00" });
    });
  });

  it("treats a file with no header as data from the first line", async () => {
    const rows = await collect(lines("SKU-1,10.00", "SKU-2,20.00"));
    expect(rows).toHaveLength(2);
    expect(rows[0].line).toBe(1);
  });

  it("keeps line numbers pointing at the merchant's spreadsheet", async () => {
    // Blank lines are skipped but must not shift the numbers, or every error in the
    // report points at the wrong row.
    const rows = await collect(lines("sku,price", "SKU-1,10.00", "", "", "SKU-2,20.00"));
    expect(rows.map((r) => r.line)).toEqual([2, 5]);
  });

  it("reads extra columns when the header names them", async () => {
    const rows = await collect(lines("sku,price,compare_at,currency", "SKU-1,10.00,15.00,EUR"));
    expect(rows[0]).toMatchObject({ compareAt: "15.00", currency: "EUR" });
  });
});

describe("a variant named on more than one row (#989, D17)", () => {
  // The price, baseline and cost imports each decided this for themselves: the first two
  // kept the first row, the cost import refused every row. One rule now, read from here.
  it("uses the first row and answers the first row's line for every later one", () => {
    const earlier = firstRows();

    expect(earlier("gid://shopify/ProductVariant/1", 3), "the first row is not a repeat").toBeNull();
    expect(earlier("gid://shopify/ProductVariant/2", 5)).toBeNull();
    expect(earlier("gid://shopify/ProductVariant/1", 14)).toBe(3);
    // A third row repeats the first, not the second: the second was never used.
    expect(earlier("gid://shopify/ProductVariant/1", 20)).toBe(3);
    expect(earlier("gid://shopify/ProductVariant/2", 21)).toBe(5);
  });

  it("keeps each import's rows to itself", () => {
    const one = firstRows();
    const two = firstRows();
    expect(one("gid://shopify/ProductVariant/1", 2)).toBeNull();
    expect(two("gid://shopify/ProductVariant/1", 9), "a second file inherited the first file's rows").toBeNull();
  });

  it("names the row it repeats, which row is used, and what to do", () => {
    const reason = duplicateRefusal(14, 3, "cost");
    expect(reason).toMatch(/^Line 14 repeats this variant's line 3; only line 3 is used\./);
    expect(reason).toMatch(/If this row's cost is the right one, delete line 3 and import the file again\./);
    expect(duplicateRefusal(9, 2, "baseline")).toContain("this row's baseline");
  });
});
