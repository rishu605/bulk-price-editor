/**
 * Reduce by 100% or more is refused wherever a campaign is made or applied (#696, #818).
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { sourceOf } from "../testing/source";
import { MAX_REDUCTION_PERCENT, reducesToNothing, reductionProblem, unappliableRule, uncopiableRule } from "./rule-limits";

const rows = (...rules: unknown[]) => rules.map((rule) => ({ segmentIds: [], rule }));

describe("the limit", () => {
  it("is anything at or past the whole price", () => {
    expect(MAX_REDUCTION_PERCENT).toBe(100);
    for (const percent of [-100, -150, -1_000]) expect(reducesToNothing(percent), String(percent)).toBe(true);
    for (const percent of [-99.99, -95, -10, 0, 150]) expect(reducesToNothing(percent), String(percent)).toBe(false);
  });

  it("is said to the editor as before (#696)", () => {
    expect(reductionProblem(-150)).toBe(
      "A 150% reduction would make every price free or negative. Enter less than 100.",
    );
    expect(reductionProblem(-95)).toBeNull();
  });
});

describe("a stored campaign's rule", () => {
  it("refuses a percentage reduction of 100% or more, naming it and what to do", () => {
    expect(unappliableRule(rows({ kind: "percent-change", percent: -150 }))).toBe(
      "This campaign reduces prices by 150%, which would make every price free or negative, so it cannot be " +
        "applied. Create a campaign with a reduction under 100% and archive this one.",
    );
    expect(unappliableRule(rows({ kind: "percent-change", percent: -100 }))).not.toBeNull();
    expect(unappliableRule(rows({ kind: "percent-of-compare-at", percent: -100 }))).not.toBeNull();
  });

  it("checks every rule row, not only the first", () => {
    expect(
      unappliableRule(rows({ kind: "percent-change", percent: -10 }, { kind: "percent-change", percent: -200 })),
    ).toContain("200%");
  });

  it("lets everything else through", () => {
    expect(unappliableRule(rows({ kind: "percent-change", percent: -95 }))).toBeNull();
    expect(unappliableRule(rows({ kind: "percent-change", percent: 150 }))).toBeNull();
    expect(unappliableRule(rows({ kind: "fixed-change", amount: money(-50_000, "USD") }))).toBeNull();
    expect(unappliableRule(rows({ kind: "from-import", importId: "i1" }))).toBeNull();
  });

  it("reads a stored value it cannot make sense of as nothing to refuse", () => {
    for (const stored of [null, undefined, {}, "x", [{}], [{ rule: null }]]) {
      expect(unappliableRule(stored), JSON.stringify(stored)).toBeNull();
    }
  });
});

describe("a copy of a stored campaign's rule (#1009)", () => {
  it("is refused for a reduction every Apply refuses, naming it and what to do instead", () => {
    expect(uncopiableRule(rows({ kind: "percent-change", percent: -10 }, { kind: "percent-of-compare-at", percent: -100 }))).toBe(
      "This campaign reduces prices by 100%, which would make every price free or negative, so a copy of it could " +
        "never be applied, and none was made. Create a new campaign with a reduction under 100% instead.",
    );
  });

  it("is made for every rule an Apply allows", () => {
    for (const rule of [
      { kind: "percent-change", percent: -95 },
      { kind: "fixed-change", amount: money(-50_000, "USD") },
      { kind: "from-import", importId: "i1" },
    ]) {
      expect(uncopiableRule(rows(rule)), JSON.stringify(rule)).toBeNull();
    }
    expect(uncopiableRule(null)).toBeNull();
  });
});

describe("the campaign page offers no Apply the run refuses", () => {
  it("withholds Apply on a preview that says the rule is refused, and says why", () => {
    // The run refuses it whatever is typed, so a button that exists only to be refused
    // would promise the merchant something the app will not do.
    const page = sourceOf("app/routes/app.campaigns.$id.tsx");
    expect(page).toContain("const unappliable = Boolean(preview.blocked || preview.refused);");
    expect(page).toMatch(/const canApply = !practice && !unappliable && /);
    expect(page).toContain("{preview.refused}");
  });
});
