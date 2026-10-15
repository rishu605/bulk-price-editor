/**
 * What a campaign does to margin.
 *
 * The tests that matter are about honesty rather than arithmetic. A blended margin that
 * quietly assumed a cost for products that have none would be a number that looks precise
 * and is invented — and a merchant would price a whole season on it.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { describeImpact, marginImpact, marginPercent, type MarginInput } from "./margin";

const row = (over: Partial<MarginInput> = {}): MarginInput => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Chair",
  cost: money(5_000, "USD"),
  before: money(10_000, "USD"),
  after: money(8_000, "USD"),
  ...over,
});

describe("gross margin", () => {
  it("is the share of the selling price that is not cost", () => {
    expect(marginPercent(money(10_000, "USD"), money(5_000, "USD"))).toBe(50);
    expect(marginPercent(money(8_000, "USD"), money(5_000, "USD"))).toBeCloseTo(37.5);
  });

  it("is negative when the price is below cost", () => {
    // Not clamped to zero. "Minus 25%" is the number that tells a merchant they lose
    // money on every sale; "0%" reads like breaking even.
    expect(marginPercent(money(4_000, "USD"), money(5_000, "USD"))).toBe(-25);
  });

  it("does not divide by zero on a free product", () => {
    expect(marginPercent(money(0, "USD"), money(5_000, "USD"))).toBe(0);
  });

  it("reads a price exactly at a margin as that margin, not a hair under it (#697)", () => {
    // $43.00 cost at $100.00 is a 57% margin. `(57 / 100) * 100` is 56.99999999999999 in
    // floats, so a price clamped exactly to a 57% floor was listed as below the 57% target
    // beside the floor that put it there.
    expect(marginPercent(money(10_000, "USD"), money(4_300, "USD"))).toBe(57);
    expect(marginPercent(money(125, "USD"), money(6, "USD"))).toBe(95.2);

    const atFloor = marginImpact([row({ cost: money(4_300, "USD"), after: money(10_000, "USD") })], 57);
    expect(atFloor.belowTarget).toEqual([]);
  });
});

describe("the impact of a campaign", () => {
  it("reports the average before and after", () => {
    const impact = marginImpact([row(), row({ variantGid: "v2" })], null);

    expect(impact.averageBefore).toBe(50);
    expect(impact.averageAfter).toBeCloseTo(37.5);
    expect(impact.averageDelta).toBeCloseTo(12.5);
  });

  it("counts products with no cost rather than estimating one", () => {
    // The whole point. Assuming a cost for the 40% of a catalogue that has none
    // produces a precise-looking number that is invented.
    const impact = marginImpact([row(), row({ variantGid: "v2", cost: undefined })], null);

    expect(impact.covered).toBe(1);
    expect(impact.unknown).toBe(1);
    // The average is over what is known, not diluted by a guess.
    expect(impact.averageBefore).toBe(50);
  });

  it("names the products that fall below the target, worst first", () => {
    // "Eleven products drop under 20%" prompts "which ones". The answer should already
    // be on screen.
    const impact = marginImpact(
      [
        row({ variantGid: "ok", after: money(9_000, "USD") }),
        row({ variantGid: "bad", after: money(5_500, "USD") }),
        row({ variantGid: "worse", after: money(5_100, "USD") }),
      ],
      20,
    );

    expect(impact.belowTarget.map((entry) => entry.variantGid)).toEqual(["worse", "bad"]);
  });

  it("separates below-cost from merely below-target", () => {
    // Different problems. Below target is a policy breach; below cost loses money on
    // every single sale and is worth its own line.
    const impact = marginImpact(
      [
        row({ variantGid: "thin", after: money(5_500, "USD") }),
        row({ variantGid: "loss", after: money(4_000, "USD") }),
      ],
      20,
    );

    expect(impact.belowCost.map((entry) => entry.variantGid)).toEqual(["loss"]);
    expect(impact.belowTarget.map((entry) => entry.variantGid)).toEqual(["loss", "thin"]);
  });

  it("reports nothing below target when no target is set", () => {
    const impact = marginImpact([row({ after: money(5_100, "USD") })], null);

    expect(impact.belowTarget).toEqual([]);
    // But below-cost still stands on its own, because that is a fact rather than a
    // policy.
    expect(impact.belowCost).toEqual([]);
  });

  it("handles a campaign that improves margin", () => {
    const impact = marginImpact([row({ after: money(12_000, "USD") })], null);

    expect(impact.averageDelta).toBeLessThan(0);
  });
});

describe("saying it in a sentence", () => {
  it("leads with the coverage caveat when costs are missing", () => {
    const impact = marginImpact([row(), row({ variantGid: "v2", cost: undefined })], null);

    expect(describeImpact(impact, null)).toContain("1 does not and is not included");
  });

  it("agrees with one on both sides of the caveat (#759)", () => {
    // "Based on the 1 products that have a cost; 1 do not and are not included" was live.
    const impact = marginImpact([row(), row({ variantGid: "v2", cost: undefined })], null);

    expect(describeImpact(impact, null)).toContain("Averaged over the 1 variant that has a cost; 1 does not and is not included.");
  });

  it("groups a large uncovered count", () => {
    const impact = { ...marginImpact([row()], null), unknown: 2702 };

    expect(describeImpact(impact, null)).toContain("2,702 do not and are not included");
  });

  it("says plainly when it knows nothing at all", () => {
    const impact = marginImpact([row({ cost: undefined })], null);

    expect(describeImpact(impact, null)).toContain("Import your costs");
  });

  it("calls out selling below cost", () => {
    const impact = marginImpact([row({ after: money(4_000, "USD") })], null);

    expect(describeImpact(impact, null)).toContain("at or below cost");
  });

  it("says margin rises when it rises", () => {
    const impact = marginImpact([row({ after: money(12_000, "USD") })], null);

    expect(describeImpact(impact, null)).toContain("rises");
  });
});

describe("the margin sentence counts variants, and says so (#795)", () => {
  // Two variants of one product, and one variant with no cost: three variants, one product.
  const impact = marginImpact(
    [
      row({ variantGid: "gid://shopify/ProductVariant/1", title: "Chair · Red" }),
      row({ variantGid: "gid://shopify/ProductVariant/2", title: "Chair · Blue" }),
      row({ variantGid: "gid://shopify/ProductVariant/3", title: "Chair · Green", cost: undefined }),
    ],
    null,
  );

  it("averages per variant, and names the variants it covers and the ones it could not", () => {
    const sentence = describeImpact(impact, null);
    expect(sentence).toMatch(/^Average margin per variant drops about/);
    expect(sentence).toContain("Averaged over the 2 variants that have a cost; 1 does not and is not included.");
    expect(sentence).not.toMatch(/products/);
  });

  it("says variants when none has a cost, and counts one in the singular", () => {
    const none = marginImpact([row({ cost: undefined })], null);
    expect(describeImpact(none, null)).toMatch(/^None of these variants has a cost recorded/);
    const oneBelow = marginImpact([row({ after: money(4_000, "USD") })], null);
    expect(describeImpact(oneBelow, null)).toContain("1 variant would sell at or below cost.");
  });
});
