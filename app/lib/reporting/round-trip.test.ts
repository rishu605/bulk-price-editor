/**
 * Export, edit, import.
 *
 * The acceptance criterion for the data I/O story is a round trip that survives a
 * spreadsheet. That is not a formality: the obvious export prints "$1,299.00" because
 * that is what reads well on screen, and the importer refuses it because a price with a
 * currency symbol is exactly the row that silently becomes the wrong number. An export
 * that cannot be re-imported is a feature that only appears to exist.
 */

import { describe, expect, it } from "vitest";

import type { BaselineRow } from "../../services/baseline-browser.server";
import { baselinesCsv, plain } from "./baselines-csv";
import { mapColumns, splitCsvLine, validateRow } from "../baselines/csv-rows";

const row = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  productGid: "gid://shopify/Product/1",
  title: "Chair",
  sku: "CH-1",
  vendor: "Acme",
  baseline: "$1,299.00",
  live: "$999.00",
  source: "INSTALL_CAPTURE",
  capturedAt: "2026-08-01T00:00:00.000Z",
  diverged: true,
  adminUrl: "https://example.myshopify.com/admin/products/1",
  ...over,
});

describe("stripping display formatting for re-import", () => {
  it("turns a formatted price into a plain number", () => {
    expect(plain("$1,299.00")).toBe("1299.00");
    expect(plain("€64,00")).toBe("6400");
    expect(plain("¥9,480")).toBe("9480");
  });

  it("keeps a negative sign", () => {
    expect(plain("-$5.00")).toBe("-5.00");
  });

  it("leaves a missing price missing rather than writing zero", () => {
    // "0" would import as a baseline of nothing, which makes every percentage campaign
    // on that variant compute to zero.
    expect(plain(null)).toBe("");
  });
});

describe("the round trip", () => {
  it("exports headers the importer recognises", () => {
    const header = splitCsvLine(baselinesCsv([row()]).split("\n")[0]);
    const map = mapColumns(header);

    expect(map).not.toBeNull();
    // The variant ID, not the SKU — and that is the right answer. A gid names exactly
    // one variant for ever; a SKU is whatever the merchant typed and may name two. The
    // importer is right to prefer the one that cannot be ambiguous, and the export
    // carries both so a merchant editing by hand still has the SKU to read.
    expect(header[map!.identifier]).toBe("Variant ID");
    expect(map!.price).not.toBeNull();
    expect(header[map!.price!]).toBe("Variant Price");
    expect(header).toContain("Variant SKU");
  });

  it("round-trips on the SKU when the ID column is removed, as a spreadsheet edit might", () => {
    // Merchants delete columns they do not recognise. Losing the gid must degrade to
    // matching on SKU rather than failing the file.
    const header = ["Variant SKU", "Title", "Variant Price"];
    const map = mapColumns(header);

    expect(map).not.toBeNull();
    expect(header[map!.identifier]).toBe("Variant SKU");
  });

  it("exports prices the importer accepts", () => {
    const line = baselinesCsv([row()]).split("\n")[1];
    const cells = splitCsvLine(line);
    const header = splitCsvLine(baselinesCsv([row()]).split("\n")[0]);
    const map = mapColumns(header)!;

    const validated = validateRow(
      {
        line: 2,
        identifier: cells[map.identifier],
        price: cells[map.price!],
      },
      "USD",
    );

    expect("parsedPrice" in validated).toBe(true);
    if ("parsedPrice" in validated) expect(validated.parsedPrice.amount).toBe(129_900);
  });

  it("survives a title containing a comma and a quote", () => {
    // Ordinary catalogue data, and the thing that breaks a naive round trip.
    const csv = baselinesCsv([row({ title: 'Monitor, 24"', sku: "M,24" })]);
    const cells = splitCsvLine(csv.split("\n")[1]);

    expect(cells[0]).toBe("M,24");
    expect(cells[2]).toBe('Monitor, 24"');
  });
});
