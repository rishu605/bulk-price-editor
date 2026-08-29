/**
 * The record of what the app did to a merchant's storefront, as a file.
 *
 * `ledger-csv.ts` states its own invariant and nothing enforced it:
 *
 *   "So a failed row keeps its reason in the file. An export that dropped the failures
 *    would show a clean run that was not clean, which is the specific dishonesty this
 *    whole product is built against."
 *
 * Both halves of that sentence could be broken — the reason blanked, and failed rows
 * filtered out entirely — with all 2,948 tests passing. This is the file attached to a
 * support ticket and handed to a finance team when a price on an invoice does not match.
 */

import { describe, expect, it } from "vitest";

import type { LedgerRow } from "../../services/campaigns/types";
import { ledgerCsv } from "./ledger-csv";

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Alpine Jacket / L",
  before: "19.99",
  intended: "15.99",
  status: "VERIFIED",
  failureReason: null,
  ...over,
});

const lines = (csv: string) => csv.trimEnd().split("\n");

describe("what the ledger export contains", () => {
  it("has a header naming every column", () => {
    expect(lines(ledgerCsv([]))[0]).toBe(
      '"Variant","Title","Before","We wrote","Status","Why not"',
    );
  });

  it("writes one line per ledger row", () => {
    expect(lines(ledgerCsv([row(), row({ variantGid: "gid://v/2" })]))).toHaveLength(3);
  });

  it("carries the before and intended prices, which are what a dispute is about", () => {
    const csv = ledgerCsv([row({ before: "19.99", intended: "15.99" })]);

    expect(csv).toContain('"19.99"');
    expect(csv).toContain('"15.99"');
  });
});

describe("a run that was not clean must not export as if it were", () => {
  const failed = row({
    status: "FAILED",
    intended: "15.99",
    failureReason: "Shopify rejected the price: compare-at must exceed price",
  });

  it("includes a failed row rather than filtering it out", () => {
    // Filtering failures produces a file showing only successes — a clean run that was
    // not clean. That is the exact dishonesty the product exists to prevent, arriving
    // through the product's own report.
    expect(ledgerCsv([row(), failed])).toContain("gid://shopify/ProductVariant/1");
    expect(lines(ledgerCsv([row(), failed]))).toHaveLength(3);
  });

  it("keeps the reason a row failed", () => {
    // A failed row with the reason blanked is worse than no export: it names a variant
    // as a problem and gives nothing to act on.
    expect(ledgerCsv([failed])).toContain("Shopify rejected the price");
  });

  it("shows the status, so a reader can sort by it", () => {
    expect(ledgerCsv([failed])).toContain('"FAILED"');
  });

  it("exports every status, not only the interesting ones", () => {
    const csv = ledgerCsv([
      row({ status: "VERIFIED" }),
      row({ status: "FAILED", failureReason: "throttled" }),
      row({ status: "SKIPPED", failureReason: "below floor" }),
      row({ status: "PENDING" }),
    ]);

    for (const status of ["VERIFIED", "FAILED", "SKIPPED", "PENDING"]) {
      expect(csv, `${status} rows must appear`).toContain(`"${status}"`);
    }
  });
});

describe("rows with nothing to report in a column", () => {
  it("writes an empty cell rather than the word null", () => {
    // `null` in a spreadsheet reads as a value the app assigned. An empty cell reads as
    // "there was nothing here", which is what it means.
    const csv = ledgerCsv([row({ before: null, intended: null, failureReason: null })]);

    expect(csv).not.toContain("null");
    expect(lines(csv)[1]).toBe(
      '"gid://shopify/ProductVariant/1","Alpine Jacket / L","","","VERIFIED",""',
    );
  });

  it("survives a title with a comma and a quote in it", () => {
    // Ordinary catalogue data. A ledger that corrupts itself on a product name is not a
    // record of anything.
    const csv = ledgerCsv([row({ title: 'Monitor, 24"' })]);

    expect(csv).toContain('"Monitor, 24"""');
  });

  it("exports a header-only file for a run with no rows", () => {
    // A campaign that planned nothing is a legitimate outcome, and a file with no header
    // is one a merchant cannot tell from a failed download.
    expect(lines(ledgerCsv([]))).toHaveLength(1);
  });
});
