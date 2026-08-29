/**
 * The rows a cost import could not use, as a file to fix and re-upload.
 *
 * The module's point is the line number: *"37 rows failed" sends a merchant scrolling
 * through a spreadsheet; "line 412, SKU-9931, cost is not a plain number" is something
 * they can act on in seconds.*
 *
 * The ordering that makes that usable — errors in the order they appear in the merchant's
 * file — could be removed with all 2,948 tests passing. A merchant would then work through
 * a list that jumps between line 412, line 9 and line 88, which is the scrolling the file
 * exists to replace.
 */

import { describe, expect, it } from "vitest";

import type { CostImportResult } from "../../services/cost-import.server";
import { costErrorCsv } from "./cost-errors";

const problem = (line: number, identifier: string, reason = "cost is not a plain number") => ({
  line,
  identifier,
  reason,
});

const result = (over: Partial<CostImportResult> = {}): CostImportResult => ({
  total: 0,
  ready: 0,
  written: 0,
  unchanged: 0,
  invalid: [],
  unmatched: [],
  ambiguous: [],
  dryRun: true,
  ...over,
});

const lines = (csv: string) => csv.trimEnd().split("\n");

describe("the error report", () => {
  it("names the four things a merchant needs to fix a row", () => {
    expect(lines(costErrorCsv(result()))[0]).toBe(
      '"Line","Identifier","Problem","What to do"',
    );
  });

  it("carries the line number, the identifier and the reason", () => {
    const csv = costErrorCsv(result({ invalid: [problem(412, "SKU-9931")] }));

    expect(csv).toContain('"412"');
    expect(csv).toContain('"SKU-9931"');
    expect(csv).toContain('"cost is not a plain number"');
  });

  it("includes all three kinds of problem, each labelled", () => {
    // A merchant fixes an invalid cost differently from an unmatched SKU, and an
    // ambiguous one differently again. Merging them into "failed" loses the instruction.
    const csv = costErrorCsv(
      result({
        invalid: [problem(2, "A")],
        unmatched: [problem(3, "B")],
        ambiguous: [problem(4, "C")],
      }),
    );

    expect(csv).toContain('"invalid"');
    expect(csv).toContain('"unmatched"');
    expect(csv).toContain('"ambiguous"');
  });
});

describe("ordering, which is what makes the file usable", () => {
  it("sorts by line number across all three kinds", () => {
    // The kinds arrive in three separate lists. Concatenating without sorting gives a
    // merchant a list that jumps between line 412, line 9 and line 88 — the scrolling
    // this file exists to replace.
    const csv = costErrorCsv(
      result({
        invalid: [problem(412, "late")],
        unmatched: [problem(9, "early")],
        ambiguous: [problem(88, "middle")],
      }),
    );

    expect(lines(csv).slice(1).map((line) => line.split(",")[0])).toEqual(['"9"', '"88"', '"412"'],
    );
  });

  it("orders numerically, not as text", () => {
    // Sorted as strings, line 100 comes before line 9 — which is exactly the case a
    // real import hits, and exactly the one a small fixture would miss.
    const csv = costErrorCsv(
      result({ invalid: [problem(100, "a"), problem(9, "b"), problem(20, "c")] }),
    );

    expect(lines(csv).slice(1).map((line) => line.split(",")[0])).toEqual(
      ['"9"', '"20"', '"100"'],
    );
  });
});

describe("an import with nothing wrong", () => {
  it("exports a header-only file rather than nothing", () => {
    // A clean import still offers the download. An empty file would look like a failed
    // one; a header with no rows says "nothing failed" unambiguously.
    expect(lines(costErrorCsv(result()))).toHaveLength(1);
  });
});
