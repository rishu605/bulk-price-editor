/**
 * The floors that stop a campaign writing a price below cost — invariant I6.
 *
 * These seven functions had no test naming any of them. They were reached only through the
 * resolver and the chaos suite, so the combinations exercised were whatever those fixtures
 * happened to produce, and six deliberate breakages passed all 2,884 tests:
 *
 *   a campaign loosening the store's minimum margin           2,884 passed
 *   a campaign loosening the store's minimum price            2,884 passed
 *   a campaign switching `neverBelowCost` off                 2,884 passed
 *   the margin floor rounding down, below the margin          2,884 passed
 *   `smallestPositive` returning zero                         2,884 passed
 *   a 100% margin no longer refused                           2,884 passed
 *
 * The first three are what `mergeGuardrails`' own comment says must be impossible.
 *
 * This is #338's shape: that bug shipped because the tests built a `ResolvableCampaign` by
 * hand and covered branches no real campaign could reach. Transitive coverage tells you the
 * paths a fixture walks, not the ones a merchant can.
 */

import { describe, expect, it } from "vitest";

import { money, type Money } from "../money/money";
import {
  computeFloor,
  MissingCostError,
  mergeGuardrails,
  needsCostButMissing,
  priceForMargin,
  smallestPositive,
  violatesFloor,
} from "./guardrails";
import type { Baseline, Guardrails } from "./types";

const usd = (amount: number): Money => money(amount, "USD");
const jpy = (amount: number): Money => money(amount, "JPY");

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  price: usd(2_000),
  ...over,
});

describe("a campaign may tighten a store guardrail, never loosen it", () => {
  // The rule the module exists to enforce: "Without this rule a campaign could disable a
  // store-wide 'never below cost' policy, making the store setting decorative."
  it("takes the higher minimum margin, whichever side asked for it", () => {
    expect(mergeGuardrails({ minMarginPercent: 40 }, { minMarginPercent: 10 }).minMarginPercent)
      .toBe(40);
    expect(mergeGuardrails({ minMarginPercent: 10 }, { minMarginPercent: 40 }).minMarginPercent)
      .toBe(40);
  });

  it("takes the higher minimum price, whichever side asked for it", () => {
    expect(mergeGuardrails({ minPrice: usd(500) }, { minPrice: usd(100) }).minPrice).toEqual(
      usd(500),
    );
    expect(mergeGuardrails({ minPrice: usd(100) }, { minPrice: usd(500) }).minPrice).toEqual(
      usd(500),
    );
  });

  it("lets either side switch `neverBelowCost` on, and neither switch it off", () => {
    expect(mergeGuardrails({ neverBelowCost: true }, { neverBelowCost: false }).neverBelowCost)
      .toBe(true);
    expect(mergeGuardrails({ neverBelowCost: false }, { neverBelowCost: true }).neverBelowCost)
      .toBe(true);
  });

  it("keeps a store guardrail the campaign says nothing about", () => {
    // The common case: a campaign sets a margin and inherits the store's floor. Dropping
    // the unmentioned field is how a store-wide policy becomes decorative by omission
    // rather than by override.
    const merged = mergeGuardrails(
      { neverBelowCost: true, minPrice: usd(500) },
      { minMarginPercent: 20 },
    );

    expect(merged.neverBelowCost).toBe(true);
    expect(merged.minPrice).toEqual(usd(500));
    expect(merged.minMarginPercent).toBe(20);
  });

  it("takes whichever side has a value when only one does", () => {
    expect(mergeGuardrails({}, { minMarginPercent: 15 }).minMarginPercent).toBe(15);
    expect(mergeGuardrails({ minMarginPercent: 15 }, {}).minMarginPercent).toBe(15);
    expect(mergeGuardrails({}, { minPrice: usd(300) }).minPrice).toEqual(usd(300));
    expect(mergeGuardrails({ minPrice: usd(300) }, {}).minPrice).toEqual(usd(300));
  });

  it("survives either side being absent entirely", () => {
    expect(mergeGuardrails(undefined, { minMarginPercent: 20 })).toEqual({ minMarginPercent: 20 });
    expect(mergeGuardrails({ minMarginPercent: 20 }, undefined)).toEqual({ minMarginPercent: 20 });
    expect(mergeGuardrails(undefined, undefined)).toEqual({});
  });
});

describe("the price that achieves a margin", () => {
  it("is cost when the margin is zero", () => {
    expect(priceForMargin(usd(1_000), 0)).toEqual(usd(1_000));
  });

  it("is cost over one minus the margin", () => {
    // 50% gross margin on $10 cost is $20: margin is a share of the *selling* price, not
    // a markup on cost. Reading it as a markup would give $15 and miss the target by a
    // third — the mistake this formula exists to avoid.
    expect(priceForMargin(usd(1_000), 50)).toEqual(usd(2_000));
    expect(priceForMargin(usd(1_000), 20)).toEqual(usd(1_250));
  });

  it("rounds up, so the floor never violates the margin it enforces", () => {
    // $10.00 at 30% is $14.2857…, which must become $14.29 rather than $14.28. A floor
    // rounded down is a floor that fails its own test, and the resolver would then clamp
    // to a price below the merchant's minimum margin.
    expect(priceForMargin(usd(1_000), 30)).toEqual(usd(1_429));
  });

  it("rounds up in a zero-decimal currency too", () => {
    // ¥1000 at 30% is ¥1428.57. Minor units in JPY are whole yen, so this is where a
    // formula written for two-decimal currencies goes wrong — the family of bugs that
    // produced the 100x JPY error and #343.
    expect(priceForMargin(jpy(1_000), 30)).toEqual(jpy(1_429));
  });

  it("keeps the currency it was given", () => {
    expect(priceForMargin(jpy(500), 20).currency).toBe("JPY");
  });

  it("handles a margin just under the ceiling", () => {
    // 99.9% is what settings.server.ts clamps to, so it is reachable and must not
    // overflow or divide by something that rounds to zero.
    //
    // Asserted as a property rather than a literal: `1 - 0.999` is 0.0009999999999999454
    // in binary floating point, so the exact answer of 100,000 comes out a minor unit
    // high. That is the *correct* direction — a floor that errs upward still achieves the
    // margin, and one that errs downward does not — and pinning 100_001 would be pinning
    // an artefact of the arithmetic rather than the guarantee.
    const price = priceForMargin(usd(100), 99.9);

    expect(price.amount).toBeGreaterThanOrEqual(100_000);
    expect(price.amount).toBeLessThanOrEqual(100_001);
    expect(Number.isSafeInteger(price.amount)).toBe(true);
  });

  it.each([100, 100.5, 250])("refuses %s%%, which no price can achieve", (margin) => {
    // Margin is a share of the selling price, so 100% needs an infinite price. Without
    // the guard this divides by zero and yields Infinity, which becomes a floor no price
    // can clear — every variant blocked, with no explanation naming the cause.
    expect(() => priceForMargin(usd(1_000), margin)).toThrow(RangeError);
  });

  it("names the margin in the refusal, so the setting can be found", () => {
    expect(() => priceForMargin(usd(1_000), 100)).toThrow(/100%/);
  });
});

describe("the effective floor", () => {
  it("is undefined when nothing constrains the variant", () => {
    // Not zero and not one minor unit: `undefined` means "no guardrail". The resolver
    // enforces strict positivity separately, and conflating the two would make a variant
    // with no guardrails look guarded.
    expect(computeFloor(baseline({ cost: usd(500) }), {})).toBeUndefined();
  });

  it("is the absolute minimum price when that is all there is", () => {
    expect(computeFloor(baseline(), { minPrice: usd(900) })).toEqual(usd(900));
  });

  it("is cost when the store refuses to go below it", () => {
    expect(computeFloor(baseline({ cost: usd(700) }), { neverBelowCost: true })).toEqual(usd(700));
  });

  it("is the margin price when a margin applies", () => {
    expect(computeFloor(baseline({ cost: usd(1_000) }), { minMarginPercent: 50 })).toEqual(
      usd(2_000),
    );
  });

  it("is the highest of everything that applies", () => {
    // Floors compose by taking the maximum. Taking any other one would let the weakest
    // guardrail decide, which is the opposite of what a guardrail is.
    const floor = computeFloor(baseline({ cost: usd(1_000) }), {
      minPrice: usd(1_200),
      neverBelowCost: true,
      minMarginPercent: 50,
    });

    expect(floor).toEqual(usd(2_000));
  });

  it("still applies the absolute minimum when it is the highest", () => {
    const floor = computeFloor(baseline({ cost: usd(1_000) }), {
      minPrice: usd(5_000),
      neverBelowCost: true,
      minMarginPercent: 50,
    });

    expect(floor).toEqual(usd(5_000));
  });
});

describe("a cost-dependent guardrail on a variant with no cost", () => {
  const noCost = baseline({ cost: undefined });

  it("throws when the policy is to error, naming what to do about it", () => {
    expect(() =>
      computeFloor(noCost, { neverBelowCost: true, missingCostPolicy: "error" }),
    ).toThrow(MissingCostError);
  });

  it("throws for a margin guardrail too, not only for neverBelowCost", () => {
    expect(() =>
      computeFloor(noCost, { minMarginPercent: 30, missingCostPolicy: "error" }),
    ).toThrow(MissingCostError);
  });

  it("leaves the cost-derived floors out when the policy is to skip", () => {
    expect(computeFloor(noCost, { neverBelowCost: true, missingCostPolicy: "skip" }))
      .toBeUndefined();
  });

  it("keeps a floor that does not depend on cost", () => {
    // The absolute minimum still applies — it was never about cost. Dropping it would
    // price a variant under a floor the merchant set for unrelated reasons.
    const floor = computeFloor(noCost, {
      neverBelowCost: true,
      minPrice: usd(400),
      missingCostPolicy: "skip",
    });

    expect(floor).toEqual(usd(400));
  });

  it("defaults to skipping rather than erroring", () => {
    // No policy set is the common case, and a run that dies on the first variant without
    // a cost is worse than one that reports which variants it left alone.
    expect(computeFloor(noCost, { neverBelowCost: true })).toBeUndefined();
  });

  it("is recognised before a floor is ever computed", () => {
    // The resolver asks this first, so the variant is blocked or skipped rather than
    // priced with the cost floor quietly missing.
    expect(needsCostButMissing(noCost, { neverBelowCost: true })).toBe(true);
    expect(needsCostButMissing(noCost, { minMarginPercent: 10 })).toBe(true);
    expect(needsCostButMissing(noCost, { minPrice: usd(100) })).toBe(false);
    expect(needsCostButMissing(noCost, {})).toBe(false);
    expect(needsCostButMissing(baseline({ cost: usd(1) }), { neverBelowCost: true })).toBe(false);
  });

  it("does not treat neverBelowCost:false as needing a cost", () => {
    expect(needsCostButMissing(noCost, { neverBelowCost: false })).toBe(false);
  });
});

describe("whether a price violates its floor", () => {
  it("is true below the floor and false at or above it", () => {
    expect(violatesFloor(usd(999), usd(1_000))).toBe(true);
    expect(violatesFloor(usd(1_000), usd(1_000))).toBe(false);
    expect(violatesFloor(usd(1_001), usd(1_000))).toBe(false);
  });

  it("is false when there is no floor", () => {
    expect(violatesFloor(usd(1), undefined)).toBe(false);
  });
});

describe("the smallest price that is still a price", () => {
  it("is one minor unit, not zero", () => {
    // Zero is not a price. This is what the resolver clamps to when a rule would produce
    // a non-positive value with no guardrail configured (edge case E10), so returning
    // zero here would write a free product and report the run clean.
    expect(smallestPositive("USD")).toEqual(usd(1));
    expect(smallestPositive("USD").amount).toBeGreaterThan(0);
  });

  it("is one minor unit in a zero-decimal currency, which is one yen", () => {
    expect(smallestPositive("JPY")).toEqual(jpy(1));
  });
});

describe("the guardrails a merchant can actually configure", () => {
  it.each([
    ["nothing set", {} as Guardrails],
    ["cost floor", { neverBelowCost: true } as Guardrails],
    ["margin floor", { minMarginPercent: 25 } as Guardrails],
    ["absolute floor", { minPrice: usd(1_500) } as Guardrails],
    ["all three", { neverBelowCost: true, minMarginPercent: 25, minPrice: usd(1_500) }],
  ])("never produces a floor at or below zero: %s", (_name, guardrails) => {
    // A floor of zero or less is indistinguishable from no floor, and would let a rule
    // price a product free while the run reported every guardrail satisfied.
    const floor = computeFloor(baseline({ cost: usd(1_000) }), guardrails);

    if (floor) expect(floor.amount).toBeGreaterThan(0);
  });
});
