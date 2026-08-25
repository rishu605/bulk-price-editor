/**
 * Bulk cost rules.
 *
 * A cost is not a price and none of this writes to a storefront — it changes what the app
 * will refuse to do. Which means the failure mode is a guardrail that quietly stops
 * guarding, and that is what these test for.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { applyCostRule, describeCostRule } from "./cost-rules";

const input = (cost?: number) => ({
  cost: cost === undefined ? undefined : money(cost, "USD"),
  basePrice: money(10_000, "USD"),
});

describe("adjusting an existing cost", () => {
  it("raises by a percentage", () => {
    expect(applyCostRule({ kind: "percent-change", percent: 4 }, input(5_000))).toEqual({
      kind: "set",
      cost: money(5_200, "USD"),
    });
  });

  it("adds a fixed amount", () => {
    expect(
      applyCostRule({ kind: "fixed-change", amount: money(250, "USD") }, input(5_000)),
    ).toEqual({ kind: "set", cost: money(5_250, "USD") });
  });

  it("skips a variant with no cost rather than treating it as zero", () => {
    // The important one. Reading "no cost" as zero and then raising it by 4% still
    // gives zero — a floor of nothing on every product the merchant had not filled in,
    // which turns the guardrail off exactly where it was most needed.
    expect(applyCostRule({ kind: "percent-change", percent: 4 }, input())).toEqual({
      kind: "skipped",
      reason: "no-cost",
    });
  });

  it("refuses a rule that would produce a negative cost", () => {
    // A negative cost makes the margin floor negative, which silently disables the
    // guardrail rather than tightening it.
    expect(
      applyCostRule({ kind: "fixed-change", amount: money(-9_000, "USD") }, input(5_000)),
    ).toEqual({ kind: "skipped", reason: "not-positive" });
  });
});

describe("setting a cost outright", () => {
  it("sets an exact amount, whether or not there was a cost before", () => {
    expect(applyCostRule({ kind: "set-exact", amount: money(4_200, "USD") }, input())).toEqual({
      kind: "set",
      cost: money(4_200, "USD"),
    });
  });

  it("derives a cost from the baseline price", () => {
    // For a merchant with no costs at all who knows the catalogue runs around 60%
    // margin. Rough, and enormously better than a guardrail that protects nothing.
    expect(applyCostRule({ kind: "share-of-price", percent: 40 }, input())).toEqual({
      kind: "set",
      cost: money(4_000, "USD"),
    });
  });

  it("allows a cost of zero", () => {
    // A sample or a giveaway genuinely costs nothing.
    expect(applyCostRule({ kind: "set-exact", amount: money(0, "USD") }, input(5_000))).toEqual({
      kind: "set",
      cost: money(0, "USD"),
    });
  });

  it("keeps the price's currency, not the rule's", () => {
    const outcome = applyCostRule({ kind: "share-of-price", percent: 50 }, {
      cost: undefined,
      basePrice: money(1_980, "JPY"),
    });

    expect(outcome).toEqual({ kind: "set", cost: money(990, "JPY") });
  });
});

describe("describing a rule", () => {
  it("says which direction a percentage goes", () => {
    expect(describeCostRule({ kind: "percent-change", percent: 4 })).toContain("Raise");
    expect(describeCostRule({ kind: "percent-change", percent: -4 })).toContain("Lower");
  });

  it("says which direction a fixed change goes", () => {
    expect(describeCostRule({ kind: "fixed-change", amount: money(250, "USD") })).toContain("Add");
    expect(describeCostRule({ kind: "fixed-change", amount: money(-250, "USD") })).toContain(
      "Subtract",
    );
  });
});
