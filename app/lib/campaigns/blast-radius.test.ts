/**
 * When the typed confirmation is asked, and what it says (A-3.11, #818).
 *
 * It counted rows and nothing else, so 95% off 999 variants applied from a one-click
 * dialog. These pin the depth test, the prices-taken-to-zero test and the sentences the
 * dialog and the server's refusal share.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import {
  asksForConfirmation,
  confirmationReasons,
  DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
  DEFAULT_CONFIRM_ABOVE_VARIANTS,
  exceedsChange,
  largeChanges,
  MINIMUM_PRICE_HANDFUL,
  movedBasisPoints,
  percentText,
  type BlastRadius,
} from "./blast-radius";

const usd = (amount: number) => money(amount, "USD");
const row = (baseline: number, after: number, cost?: number, variantGid = "v") => ({
  variantGid,
  baseline: usd(baseline),
  after: usd(after),
  ...(cost === undefined ? {} : { cost: usd(cost) }),
});

const radius = (over: Partial<BlastRadius> = {}): BlastRadius => ({
  thresholds: { variants: DEFAULT_CONFIRM_ABOVE_VARIANTS, changePercent: DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT },
  planned: 3,
  largeChanges: 0,
  largest: null,
  atMinimum: 0,
  ...over,
});

describe("the defaults are the PRD's", () => {
  it("is 1,000 variants and 50%", () => {
    expect(DEFAULT_CONFIRM_ABOVE_VARIANTS).toBe(1_000);
    expect(DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT).toBe(50);
  });
});

describe("how far a price moves", () => {
  it("exceeds 50% only past it, in either direction", () => {
    expect(exceedsChange(row(10_000, 5_000), 50), "exactly half off is not more than half").toBe(false);
    expect(exceedsChange(row(10_000, 4_999), 50)).toBe(true);
    expect(exceedsChange(row(10_000, 15_000), 50)).toBe(false);
    expect(exceedsChange(row(10_000, 15_001), 50), "an increase counts as much as a cut").toBe(true);
  });

  it("catches 95% off 249.99, which is the issue's own example", () => {
    expect(exceedsChange(row(24_999, 1_250), 50)).toBe(true);
    expect(exceedsChange(row(24_999, 1), 50), "a price taken to one cent").toBe(true);
  });

  it("leaves an ordinary sale alone", () => {
    expect(exceedsChange(row(24_999, 19_999), 50)).toBe(false);
  });

  it("follows the store's threshold", () => {
    expect(exceedsChange(row(10_000, 8_000), 50)).toBe(false);
    expect(exceedsChange(row(10_000, 8_000), 15)).toBe(true);
    expect(exceedsChange(row(10_000, 8_000), 20), "exactly the threshold is not past it").toBe(false);
  });

  it("asks when a price lands that far below its cost, on a small move", () => {
    // Baseline already under cost: a 25% cut is no deep change, but 45 is under half of 100.
    expect(exceedsChange(row(6_000, 4_500, 10_000), 50)).toBe(true);
    expect(exceedsChange(row(6_000, 5_000, 10_000), 50), "exactly half of cost").toBe(false);
    expect(exceedsChange(row(6_000, 4_500), 50), "no cost, no cost test").toBe(false);
  });

  it("never compares across currencies, or a percentage of nothing", () => {
    expect(exceedsChange({ variantGid: "v", baseline: usd(10_000), after: money(100, "EUR") }, 50)).toBe(false);
    expect(exceedsChange(row(0, 500), 50), "a free product has no percentage to move by").toBe(false);
  });

  it("is computed in integers, so a float cannot decide it at the boundary", () => {
    // 7 / 100 * 100 is 7.000000000000001 in floating point, which is "more than 7%". The
    // move is exactly 7%, and cross-multiplying in minor units says so (rule 7).
    expect(Math.abs(93 - 100) / 100 * 100 > 7, "the float this guards against").toBe(true);
    expect(exceedsChange(row(100, 93), 7)).toBe(false);
    expect(exceedsChange(row(100, 92), 7)).toBe(true);
  });
});

describe("the largest change", () => {
  it("counts every price past the threshold and keeps the furthest", () => {
    const found = largeChanges(
      [row(10_000, 9_000, undefined, "a"), row(24_999, 1_250, undefined, "b"), row(10_000, 3_000, undefined, "c")],
      50,
    );
    expect(found.count).toBe(2);
    expect(found.largest).toMatchObject({ variantGid: "b", basisPoints: 9_499 });
  });

  it("is nothing when nothing exceeds", () => {
    expect(largeChanges([row(10_000, 9_000)], 50)).toEqual({ count: 0, largest: null });
  });

  it("says a move in basis points, rounded to a tenth for reading", () => {
    expect(movedBasisPoints(row(24_999, 1_250))).toBe(9_499);
    expect(percentText(9_499)).toBe("95%");
    expect(percentText(9_450)).toBe("94.5%");
    expect(percentText(15_000)).toBe("150%");
  });
});

describe("whether the word is asked", () => {
  it("asks for none of an ordinary campaign", () => {
    expect(asksForConfirmation(radius())).toBe(false);
  });

  it("asks over the variant threshold, and not at it", () => {
    expect(asksForConfirmation(radius({ planned: 1_000 }))).toBe(false);
    expect(asksForConfirmation(radius({ planned: 1_001 }))).toBe(true);
    expect(asksForConfirmation(radius({ planned: 3, thresholds: { variants: 2, changePercent: 50 } }))).toBe(true);
  });

  it("asks for one price past the change threshold, on a campaign of three", () => {
    expect(asksForConfirmation(radius({ largeChanges: 1 }))).toBe(true);
  });

  it("asks for more than a handful of prices taken to zero, and lets a handful through", () => {
    expect(MINIMUM_PRICE_HANDFUL).toBe(5);
    expect(asksForConfirmation(radius({ atMinimum: MINIMUM_PRICE_HANDFUL }))).toBe(false);
    expect(asksForConfirmation(radius({ atMinimum: MINIMUM_PRICE_HANDFUL + 1 }))).toBe(true);
  });
});

describe("what it says", () => {
  it("names the count and the store's threshold", () => {
    expect(confirmationReasons(radius({ planned: 5_000 }))).toEqual([
      "This campaign writes 5,000 prices, more than the 1,000 your settings allow without a typed confirmation.",
    ]);
  });

  it("names how many prices move too far and the largest, by title and percentage", () => {
    const [sentence] = confirmationReasons(
      radius({
        largeChanges: 3,
        largest: { title: "Wool coat", before: "$249.99", after: "$12.50", basisPoints: 9_499, direction: "down" },
      }),
    );
    expect(sentence).toBe(
      "3 prices move more than 50% from their baseline, or land that far below cost; the largest is “Wool coat”, down 95%.",
    );
  });

  it("never carries a price, so the refusal built from it cannot log one", () => {
    const sentences = confirmationReasons(
      radius({
        planned: 5_000,
        largeChanges: 1,
        largest: { title: "Wool coat", before: "$249.99", after: "$12.50", basisPoints: 9_499, direction: "down" },
        atMinimum: 40,
      }),
    ).join(" ");
    expect(sentences).not.toContain("$");
    expect(sentences).not.toContain("249.99");
    expect(sentences).toContain("40 prices would reach zero or below");
  });

  it("says nothing for a handful taken to zero, which does not ask", () => {
    expect(confirmationReasons(radius({ atMinimum: MINIMUM_PRICE_HANDFUL }))).toEqual([]);
  });
});
