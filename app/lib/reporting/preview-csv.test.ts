/**
 * Exporting the review step.
 *
 * The screen shows a sample; this is the whole thing, and it is what a merchant
 * actually checks before putting a sale live across several markets.
 */

import { describe, expect, it } from "vitest";

import type { MarketPreview, PreviewRow } from "../../services/campaigns/types";
import { previewCsv } from "./preview-csv";

const markets: MarketPreview[] = [
  {
    priceListGid: "gid://shopify/PriceList/eu",
    name: "Europe",
    currency: "EUR",
    path: "per-product",
    explanation: "",
    clamped: 0,
    skipped: 0,
  },
  {
    priceListGid: "gid://shopify/PriceList/jp",
    name: "Japan",
    currency: "JPY",
    path: "market-wide",
    explanation: "",
    clamped: 0,
    skipped: 0,
  },
];

const row = (over: Partial<PreviewRow> = {}): PreviewRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Chair",
  before: "$100.00",
  after: "$80.00",
  compareAt: "$100.00",
  status: "pending",
  ...over,
});

describe("exporting the preview with surface columns", () => {
  it("gives every market a price column and a compare-at column", () => {
    const csv = previewCsv([row()], markets);

    expect(csv.split("\n")[0]).toBe(
      '"Variant","Title","Before","After","Compare at","State","Reason",' +
        '"Europe (EUR)","Europe compare at","Japan (JPY)","Japan compare at"',
    );
  });

  it("carries each market's own prices through", () => {
    const csv = previewCsv(
      [
        row({
          surfaces: {
            "gid://shopify/PriceList/eu": {
              after: "€64.00",
              compareAt: "€80.00",
              status: "pending",
            },
            "gid://shopify/PriceList/jp": {
              after: "¥9,480",
              compareAt: null,
              status: "pending",
            },
          },
        }),
      ],
      markets,
    );

    expect(csv).toContain('"€64.00","€80.00","¥9,480",""');
  });

  it("says a variant is not sold in a market rather than leaving the cell empty", () => {
    // An empty cell reads as "no change" in a spreadsheet. "Not sold here" is a
    // different fact about the catalogue, and the one the merchant needs.
    const csv = previewCsv([row({ surfaces: {} })], markets);

    expect(csv).toContain('"not sold here","not sold here","not sold here","not sold here"');
  });

  it("carries a skipped market row's reason instead of a price", () => {
    const csv = previewCsv(
      [
        row({
          surfaces: {
            "gid://shopify/PriceList/eu": {
              after: null,
              compareAt: null,
              status: "skipped",
              reason: "below-cost",
            },
          },
        }),
      ],
      markets.slice(0, 1),
    );

    expect(csv).toContain('"skipped: below-cost",""');
  });

  it("quotes titles containing commas and inches", () => {
    // Ordinary catalogue data. A report that corrupts itself on `Monitor, 24"` is not
    // a record of anything.
    const csv = previewCsv([row({ title: 'Monitor, 24"' })], []);

    expect(csv).toContain('"Monitor, 24"""');
  });
});
