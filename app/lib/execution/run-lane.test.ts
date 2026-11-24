import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLD } from "../planning/write-path";
import { estimateMs, MAX_INLINE_ROWS, PAGE_INLINE_BUDGET_MS } from "./inline-budget";
import { SMALL_RUN_MS, smallRun, smallVariantRun } from "./run-lane";

describe("which runs go on the small-run lane (#809)", () => {
  it("takes a one-variant run, and anything the campaign page itself writes", () => {
    expect(smallRun({ variants: 1, products: 1, taggedProducts: 1 })).toBe(true);
    // Fifty variants on fifty tagged products: the page's own ceiling fits the lane.
    expect(smallRun({ variants: MAX_INLINE_ROWS, products: MAX_INLINE_ROWS, taggedProducts: MAX_INLINE_ROWS })).toBe(true);
  });

  it("is time, not rows: about ninety tagged products, or a hundred and sixty untagged", () => {
    expect(smallRun({ variants: 90, products: 90, taggedProducts: 90 })).toBe(true);
    expect(smallRun({ variants: 100, products: 100, taggedProducts: 100 })).toBe(false);
    expect(smallRun({ variants: 160, products: 160, taggedProducts: 0 })).toBe(true);
    expect(smallRun({ variants: 170, products: 170, taggedProducts: 0 })).toBe(false);
    // Many variants on few products is one call a product: still small.
    expect(smallRun({ variants: 900, products: 10, taggedProducts: 10 })).toBe(true);
  });

  it("never takes a bulk-path run, which has no estimate at all", () => {
    const bulk = { variants: DEFAULT_THRESHOLD + 1, products: 1, taggedProducts: 0 };
    expect(estimateMs(bulk)).toBeNull();
    expect(smallRun(bulk)).toBe(false);
  });

  it("is what the page itself can wait for", () => {
    expect(SMALL_RUN_MS).toBe(PAGE_INLINE_BUDGET_MS);
  });

  it("counts an enrolment's variants as products each, erring toward the large lane", () => {
    expect(smallVariantRun(3, true)).toBe(true);
    expect(smallVariantRun(400, true)).toBe(false);
    expect(smallVariantRun(160, false)).toBe(true);
  });
});
