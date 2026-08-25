/**
 * Exporting the reconciliation view.
 *
 * This is the file a merchant forwards to whoever asked whether the prices are right, so
 * every column has to stand on its own.
 */

import { describe, expect, it } from "vitest";

import type { ReconciliationRow } from "../../services/reconciliation.server";
import { describeState, reconciliationCsv } from "./reconciliation-csv";

const row = (over: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Chair",
  sku: "CH-1",
  priceListGid: "",
  surface: "Base price",
  currency: "USD",
  live: "$80.00",
  baseline: "$100.00",
  campaignId: "c1",
  campaignName: "Summer sale",
  intended: "$80.00",
  drifted: false,
  offBaseline: true,
  adminUrl: "https://example.myshopify.com/admin/products/1",
  ...over,
});

describe("describing what is going on with a price", () => {
  it("puts drift first, because it is the only one to act on", () => {
    // A drifted row is also off baseline. Reporting "on sale" there would bury the one
    // fact the merchant needs.
    expect(describeState(row({ drifted: true, offBaseline: true })))
      .toContain("drifted");
  });

  it("reads a campaign price as a sale rather than a problem", () => {
    // Being off baseline is what a sale *is*. Calling it a warning would make every
    // running campaign look broken.
    expect(describeState(row())).toBe("on sale, as written");
  });

  it("flags a price that is off baseline with nothing controlling it", () => {
    expect(describeState(row({ campaignName: null, campaignId: null })))
      .toContain("no campaign controls it");
  });

  it("says so plainly when a price is exactly its baseline", () => {
    expect(describeState(row({ offBaseline: false }))).toBe("at baseline");
  });
});

describe("the exported file", () => {
  it("names every column a reader needs to check a price", () => {
    expect(reconciliationCsv([row()]).split("\n")[0]).toBe(
      '"Variant","Title","SKU","Surface","Currency","Live price","Baseline",' +
        '"Controlled by","We wrote","State"',
    );
  });

  it("says in words when there is no campaign or no baseline", () => {
    // An empty cell in a spreadsheet reads as missing data, and the merchant cannot
    // tell that apart from a broken export.
    const csv = reconciliationCsv([
      row({ campaignName: null, baseline: null, intended: null }),
    ]);

    expect(csv).toContain('"no baseline"');
    expect(csv).toContain('"no campaign"');
    expect(csv).toContain('"nothing written"');
  });

  it("keeps each market on its own row", () => {
    const csv = reconciliationCsv([
      row({ surface: "Base price", live: "$80.00" }),
      row({ surface: "Europe", currency: "EUR", live: "€64.00" }),
    ]);

    expect(csv.trim().split("\n")).toHaveLength(3);
    expect(csv).toContain('"Europe"');
  });

  it("quotes a title containing a comma", () => {
    expect(reconciliationCsv([row({ title: 'Monitor, 24"' })])).toContain('"Monitor, 24"""');
  });
});
