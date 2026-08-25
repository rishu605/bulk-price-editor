/**
 * Market adjustments, in integers.
 *
 * Shopify reports a percentage as a JSON number. Carrying that float through a
 * six-figure catalogue is how a market ends up full of prices a penny off that nobody
 * can account for — so it becomes basis points at the boundary and stays integer.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { money } from "../money/money";
import { applyAdjustment, isFixedOrigin, isRelative, toBasisPoints, toPercent } from "./adjustment";

describe("toBasisPoints", () => {
  it("makes a decrease negative, so direction rides with the number", () => {
    expect(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: 5 })).toBe(-500);
    expect(toBasisPoints({ type: "PERCENTAGE_INCREASE", value: 5 })).toBe(500);
  });

  it("keeps two decimal places of a percentage", () => {
    expect(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: 12.5 })).toBe(-1250);
    expect(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: 0.01 })).toBe(-1);
  });

  it("treats zero as a real adjustment, not as absent", () => {
    // A list with a 0% parent adjustment is relative and repriceable in one mutation.
    // Reading it as "no adjustment" would send us down the per-variant write path.
    expect(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: 0 })).toBe(-0);
    expect(isRelative(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: 0 }))).toBe(true);
  });

  it("returns null for anything it does not recognise", () => {
    // Distinct from zero. Conflating "unparseable" with "no change" would mirror a
    // market at the wrong price with nothing to indicate it.
    expect(toBasisPoints(null)).toBeNull();
    expect(toBasisPoints(undefined)).toBeNull();
    expect(toBasisPoints({ type: "SOMETHING_NEW" as never, value: 5 })).toBeNull();
    expect(toBasisPoints({ type: "PERCENTAGE_DECREASE", value: NaN })).toBeNull();
  });

  it("round-trips through a percentage", () => {
    expect(toPercent(-500)).toBe(-5);
    expect(toPercent(1250)).toBe(12.5);
  });
});

describe("applyAdjustment", () => {
  it("applies a decrease", () => {
    expect(applyAdjustment(money(10_000, "USD"), -500)).toEqual(money(9_500, "USD"));
  });

  it("applies an increase", () => {
    expect(applyAdjustment(money(10_000, "USD"), 1_000)).toEqual(money(11_000, "USD"));
  });

  it("leaves a zero adjustment exactly where it was", () => {
    expect(applyAdjustment(money(1_234, "USD"), 0)).toEqual(money(1_234, "USD"));
  });

  it("keeps the currency of the base price", () => {
    expect(applyAdjustment(money(1_000, "JPY"), -1_000).currency).toBe("JPY");
  });

  it("never produces a fractional minor unit", () => {
    // The whole point of integer arithmetic. A market price of 949.9999 is not a price.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: -9_900, max: 100_000 }),
        (amount, bps) => {
          const result = applyAdjustment(money(amount, "USD"), bps);
          expect(Number.isInteger(result.amount)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is symmetric about the rounding boundary", () => {
    // Rounds half away from zero, as Shopify does. Asymmetric rounding would make a
    // market price drift by a penny every time a campaign recomputed it.
    expect(applyAdjustment(money(101, "USD"), -5_000)).toEqual(money(51, "USD"));
    expect(applyAdjustment(money(101, "USD"), 5_000)).toEqual(money(152, "USD"));
  });
});

describe("origin", () => {
  it("counts only FIXED entries as worth mirroring per variant", () => {
    // A RELATIVE entry is the parent percentage applied. Mirroring it would restate
    // one number a few million times across a large catalogue.
    expect(isFixedOrigin("FIXED")).toBe(true);
    expect(isFixedOrigin("RELATIVE")).toBe(false);
    expect(isFixedOrigin(null)).toBe(false);
  });
});
