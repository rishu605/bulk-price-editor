/**
 * The file a merchant fixes their import from.
 *
 * The point of the download is that the rows get corrected and re-uploaded, so the
 * failure that matters is not a crash — it is the file arriving *incomplete* and looking
 * finished. A merchant fixes what the file lists, re-uploads, and the same rows fail
 * again with nothing to explain why.
 *
 * That is the same shape as the `ledger-csv.ts` finding in #531: failed rows filtered out
 * of the export whose own comment calls it "the specific dishonesty this whole product is
 * built against". Before this file, dropping a whole category from the report passed the
 * entire suite.
 */

import { describe, expect, it } from "vitest";

import { importErrorCsv, type ProblemReport } from "./baseline-errors";

const report: ProblemReport = {
  invalid: [{ line: 7, identifier: "SKU-INVALID", reason: "price is not a number" }],
  unmatched: [{ line: 2, identifier: "SKU-UNMATCHED", reason: "no variant with that SKU" }],
  ambiguous: [{ line: 5, identifier: "SKU-AMBIGUOUS", reason: "matches 3 variants" }],
};

/** The data rows, without the header. */
function rows(csv: string): string[] {
  return csv.trim().split("\n").slice(1);
}

/** The line column, unquoted — `toCsv` quotes every cell, including the numeric ones. */
function lineNumbers(csv: string): number[] {
  return rows(csv).map((row) => Number(row.split(",")[0].replace(/"/g, "")));
}

describe("every problem reaches the file", () => {
  it.each([
    ["invalid", "SKU-INVALID"],
    ["unmatched", "SKU-UNMATCHED"],
    ["ambiguous", "SKU-AMBIGUOUS"],
  ])("includes the %s rows", (_kind, identifier) => {
    expect(
      importErrorCsv(report),
      `a category missing from the download is a merchant re-uploading rows that will ` +
        `fail again, with nothing in the file to say why`,
    ).toContain(identifier);
  });

  it("writes one row per problem and no more", () => {
    expect(rows(importErrorCsv(report))).toHaveLength(3);
  });

  it("names which kind of problem each row is", () => {
    const csv = importErrorCsv(report);

    // Not just "the word appears somewhere": it has to be on the row it describes,
    // otherwise every row says something is wrong and none says what.
    expect(csv).toMatch(/SKU-INVALID.*invalid/);
    expect(csv).toMatch(/SKU-UNMATCHED.*unmatched/);
    expect(csv).toMatch(/SKU-AMBIGUOUS.*ambiguous/);
  });

  it("carries the reason, which is the only actionable column", () => {
    expect(importErrorCsv(report)).toContain("matches 3 variants");
  });

  it("has a header, so the file opens as a spreadsheet rather than as data", () => {
    expect(importErrorCsv(report).split("\n")[0]).toContain("line");
  });
});

describe("ordering", () => {
  /**
   * The merchant reads this file beside the spreadsheet they uploaded. Grouped by
   * category — which is the order the categories are concatenated in — the lines jump
   * 7, 2, 5 and the file stops being usable against the original.
   */
  it("follows the merchant's file, not our category order", () => {
    expect(lineNumbers(importErrorCsv(report))).toEqual([2, 5, 7]);
  });

  it("sorts numerically, not as text", () => {
    // The bug a string sort produces: 10 before 9, which looks almost right and is
    // wrong exactly where a file is long enough for it to matter.
    const csv = importErrorCsv({
      invalid: [
        { line: 10, identifier: "TEN", reason: "r" },
        { line: 9, identifier: "NINE", reason: "r" },
        { line: 100, identifier: "HUNDRED", reason: "r" },
      ],
      unmatched: [],
      ambiguous: [],
    });

    expect(lineNumbers(csv)).toEqual([9, 10, 100]);
  });
});

describe("edges", () => {
  it("returns a header and nothing else when there is nothing wrong", () => {
    const csv = importErrorCsv({ invalid: [], unmatched: [], ambiguous: [] });

    expect(rows(csv)).toEqual([]);
    expect(csv).toContain("line");
  });

  /**
   * These identifiers are SKUs, which arrive from Shopify — which accepts them from
   * suppliers, feeds and other apps. `toCsv` neutralises a leading formula character;
   * this is here so that protection cannot be lost by this export building its rows
   * some other way.
   */
  it("does not let an identifier become a formula", () => {
    const csv = importErrorCsv({
      invalid: [{ line: 1, identifier: "=1+1", reason: "r" }],
      unmatched: [],
      ambiguous: [],
    });

    expect(csv).not.toMatch(/(^|,)"?=1\+1/);
  });
});
