/**
 * What a pasted list matched, counted in rows and in variants, never one over the other
 * (#759).
 *
 * Live, 25 Sep: a list of two product ids, one of them a 2,048-variant product, was
 * reported as "Created 'QA recap big' with 2049 of 2 rows" and "2049 of 2 rows matched a
 * product. Every row was placed." -- variants over rows, with "of" between them.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { listCreatedMessage, listMatchedSentence, placedRows } from "./list-report";

const report = (over: Partial<Parameters<typeof placedRows>[0]> = {}) => ({
  total: 2,
  matched: 2_049,
  unmatched: [],
  ambiguous: [],
  repeated: 0,
  ...over,
});

describe("rows placed", () => {
  it("is every row that matched, not the variants they matched", () => {
    expect(placedRows(report())).toBe(2);
  });

  it("leaves out rows that matched nothing, matched several, or repeated an earlier one", () => {
    expect(placedRows(report({ total: 10, unmatched: [{}, {}], ambiguous: [{}], repeated: 3 }))).toBe(4);
  });
});

describe("the sentences", () => {
  it("counts rows against rows and says the variants separately", () => {
    expect(listMatchedSentence(report())).toBe("2 of 2 rows matched a product, 2,049 variants in all.");
    expect(listCreatedMessage("QA recap big", report())).toBe('Created "QA recap big" with 2,049 variants, from 2 of 2 rows.');
  });

  it("agrees with one", () => {
    const one = report({ total: 1, matched: 1 });

    expect(listMatchedSentence(one)).toBe("1 of 1 row matched a product, 1 variant in all.");
    expect(listCreatedMessage("Single", one)).toBe('Created "Single" with 1 variant, from 1 of 1 row.');
  });
});

describe("the segments page", () => {
  const page = sourceOf("app/routes/app.settings.segments.tsx");

  it("says these, rather than putting variants over rows", () => {
    expect(page).toContain("listCreatedMessage(name, report)");
    expect(page).toContain("listMatchedSentence(report)");
    expect(page).not.toContain("${outcome.matched.length} of ${outcome.total} rows");
    expect(page).not.toContain("{report.matched} of {report.total} rows");
  });
});
