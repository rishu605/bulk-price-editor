/**
 * What an import says it would do and did, in counts that agree with one (#759).
 *
 * Live, 25 Sep: the baseline import's button read "Import 1 baselines", and its counts
 * were the only ones on the page left ungrouped.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { importCheckMessage, importedMessage, importLabel } from "./messages";

describe("the commit button", () => {
  it("says the noun in the singular for one, and groups a large count", () => {
    expect(importLabel(1, "baseline")).toBe("Import 1 baseline");
    expect(importLabel(3_669, "baseline")).toBe("Import 3,669 baselines");
    expect(importLabel(1, "cost")).toBe("Import 1 cost");
  });
});

describe("a check", () => {
  it("says how many rows of the file would be imported, and that nothing was written", () => {
    expect(importCheckMessage(2_702, 3_669)).toBe("2,702 of 3,669 rows would be imported. Nothing has been written.");
    expect(importCheckMessage(1, 1)).toBe("1 of 1 row would be imported. Nothing has been written.");
  });
});

describe("a commit", () => {
  it("counts what it wrote and what it left alone, agreeing with one", () => {
    expect(importedMessage(1, "baseline", 0)).toBe("Imported 1 baseline.");
    expect(importedMessage(3_669, "baseline", 1)).toBe("Imported 3,669 baselines. 1 already matched and was left alone.");
    expect(importedMessage(0, "cost", 1_200)).toBe("Imported 0 costs. 1,200 already matched and were left alone.");
  });
});

describe("the baseline and cost pages say them", () => {
  const BASELINES = sourceOf("app/routes/app.prices.baselines._index.tsx");
  const COSTS = sourceOf("app/routes/app.prices.costs.tsx");

  it("both answer with these sentences rather than their own", () => {
    for (const [page, source, noun] of [["baselines", BASELINES, "baseline"], ["costs", COSTS, "cost"]] as const) {
      expect(source, page).toContain(`importLabel(ready, "${noun}")`);
      expect(source, page).toContain("importCheckMessage(");
      expect(source, page).toContain(`importedMessage(`);
      expect(source, page).not.toMatch(/`Import \$\{ready\}/);
    }
  });

  it("reports what a baseline commit wrote, as the cost import does", () => {
    // "What happened" showed Rows read, Ready, Already correct and Need attention, and no
    // count of what was written (#759).
    expect(BASELINES).toContain('{ label: "Written", value: result.written }');
  });

  it("groups the cost coverage sentence", () => {
    // "2702 of 3669 variants have a cost".
    expect(COSTS).toMatch(/\{formatCount\(withCost\)\} of \{countOf\(variants, "variant"\)\}/);
  });
});
