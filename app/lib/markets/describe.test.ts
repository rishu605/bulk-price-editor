/**
 * The wording a merchant reads next to each market checkbox.
 *
 * This is the sentence that tells them which price their discount comes off. A market
 * normally 10% below the base price gives a different sale price than one 10% above,
 * and the checkbox is where that becomes predictable rather than a surprise after the
 * run.
 */

import { describe, expect, it } from "vitest";

import { describeAdjustment } from "./describe";

describe("describing a market's standing adjustment", () => {
  it("reads a decrease as below the base price", () => {
    expect(describeAdjustment(-1000)).toBe("10% below");
  });

  it("reads an increase as above it", () => {
    expect(describeAdjustment(2000)).toBe("20% above");
  });

  it("keeps fractional percentages that basis points can express", () => {
    // 12.5% is an ordinary market adjustment and 1250 bps is exactly it. Rounding to
    // "13% below" would misstate the merchant's own configuration back to them.
    expect(describeAdjustment(-1250)).toBe("12.50% below");
  });

  it("says plainly when a market does not adjust at all", () => {
    expect(describeAdjustment(0)).toBe("the same as");
  });
});
