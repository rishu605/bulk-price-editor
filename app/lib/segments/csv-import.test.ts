/**
 * What the importer refuses to do.
 *
 * The matching itself is unremarkable. What matters is the four-way split: a merchant
 * uploading 3,000 SKUs needs to know before anything is priced which rows could not be
 * placed, and a row that could be placed two ways is a question rather than a match.
 * Resolving a SKU collision on their behalf is how the wrong product ends up
 * discounted, with nothing to indicate it until a customer notices.
 */

import { describe, expect, it } from "vitest";

import {
  buildMatchIndex,
  firstCell,
  identifierKindOf,
  matchIdentifiers,
  parseIdentifierCsv,
} from "./csv-import";

const variants = [
  { variantGid: "gid://shopify/ProductVariant/1", productGid: "gid://shopify/Product/10", sku: "SHIRT-S", barcode: "5012345678900" },
  { variantGid: "gid://shopify/ProductVariant/2", productGid: "gid://shopify/Product/10", sku: "SHIRT-M", barcode: null },
  // A SKU reused across two products. Common in imported catalogues, and the reason
  // the index maps to lists rather than single gids.
  { variantGid: "gid://shopify/ProductVariant/3", productGid: "gid://shopify/Product/20", sku: "DUP", barcode: null },
  { variantGid: "gid://shopify/ProductVariant/4", productGid: "gid://shopify/Product/30", sku: "dup", barcode: null },
];

const index = buildMatchIndex(variants);
const match = (values: string[]) =>
  matchIdentifiers(
    values.map((value, i) => ({ line: i + 1, value })),
    index,
  );

describe("parseIdentifierCsv", () => {
  it("takes the first column and drops a header row", () => {
    const { rows, skippedHeader } = parseIdentifierCsv("sku,title\nSHIRT-S,Blue shirt\nSHIRT-M,Blue shirt\n");
    expect(skippedHeader).toBe("sku");
    expect(rows).toEqual([
      { line: 2, value: "SHIRT-S" },
      { line: 3, value: "SHIRT-M" },
    ]);
  });

  it("keeps a file that has no header", () => {
    const { rows, skippedHeader } = parseIdentifierCsv("SHIRT-S\nSHIRT-M\n");
    expect(skippedHeader).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it("reports the original line number, not the row index", () => {
    // Blank lines are skipped but must not shift the numbers, or the error report
    // points at the wrong row in the merchant's spreadsheet.
    const { rows } = parseIdentifierCsv("SHIRT-S\n\n\nSHIRT-M\n");
    expect(rows.map((r) => r.line)).toEqual([1, 4]);
  });

  it("honours quotes so a comma inside a cell does not split it", () => {
    expect(firstCell('"Red, large",99')).toBe("Red, large");
    expect(firstCell('"24"" monitor",1')).toBe('24" monitor');
  });
});

describe("identifierKindOf", () => {
  it("recognises gids by prefix and long digit strings as barcodes", () => {
    expect(identifierKindOf("gid://shopify/ProductVariant/1")).toBe("variant-gid");
    expect(identifierKindOf("gid://shopify/Product/10")).toBe("product-gid");
    expect(identifierKindOf("5012345678900")).toBe("barcode");
    expect(identifierKindOf("SHIRT-S")).toBe("sku");
  });
});

describe("matchIdentifiers", () => {
  it("matches SKUs case-insensitively", () => {
    expect(match(["shirt-s"]).matched).toEqual(["gid://shopify/ProductVariant/1"]);
  });

  it("expands a product gid to all of its variants", () => {
    // An instruction, not a collision: naming a product means its variants.
    const out = match(["gid://shopify/Product/10"]);
    expect(out.matched).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
    expect(out.ambiguous).toHaveLength(0);
  });

  it("refuses to choose when a SKU matches more than one variant", () => {
    // The one that matters. Picking either would discount a product the merchant
    // never reviewed, and nothing downstream would reveal it.
    const out = match(["DUP"]);
    expect(out.matched).toEqual([]);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0].candidates).toEqual([
      "gid://shopify/ProductVariant/3",
      "gid://shopify/ProductVariant/4",
    ]);
  });

  it("reports unmatched rows with the line they came from", () => {
    const out = matchIdentifiers([{ line: 7, value: "NOPE" }], index);
    expect(out.matched).toEqual([]);
    expect(out.unmatched).toEqual([{ line: 7, value: "NOPE" }]);
  });

  it("falls back between SKU and barcode rather than failing", () => {
    // A numeric SKU looks like a barcode. Telling the merchant their file is
    // unmatched because of our guess about digits would be our bug, not their data.
    expect(match(["5012345678900"]).matched).toEqual(["gid://shopify/ProductVariant/1"]);
  });

  it("counts a repeated identifier once and says it was repeated", () => {
    const out = match(["SHIRT-S", "SHIRT-S"]);
    expect(out.matched).toEqual(["gid://shopify/ProductVariant/1"]);
    expect(out.repeated).toHaveLength(1);
    expect(out.repeated[0].line).toBe(2);
  });

  it("never lists the same variant twice when two identifiers reach it", () => {
    // The product gid and one of its variants, both named. The segment is a set.
    const out = match(["gid://shopify/Product/10", "gid://shopify/ProductVariant/1"]);
    expect(out.matched).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
  });

  it("keeps every bucket accounted for", () => {
    const out = match(["SHIRT-S", "NOPE", "DUP", "SHIRT-S"]);
    expect(out.matched).toHaveLength(1);
    expect(out.unmatched).toHaveLength(1);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.repeated).toHaveLength(1);
  });
});
