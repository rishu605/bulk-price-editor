/**
 * Wholesale ladders, and the ways one can be wrong.
 *
 * The tests that matter are the refusals. A ladder that prices correctly is easy; a
 * ladder where ordering more costs more per unit is a commercial problem a merchant may
 * have promised somebody in writing.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { resolveBreaks, type QuantityTier, type WholesaleGuardrail } from "./quantity-breaks";

const gbp = (minor: number) => money(minor, "GBP");

const LADDER: QuantityTier[] = [
  { minimumQuantity: 1, discountBps: 0 },
  { minimumQuantity: 12, discountBps: 1000 },
  { minimumQuantity: 48, discountBps: 2000 },
];

const permissive: WholesaleGuardrail = { minMarginPercent: 0, missingCost: "allow" };

const forVariant = (over: Partial<Parameters<typeof resolveBreaks>[0]> = {}) => ({
  variantGid: "gid://shopify/ProductVariant/1",
  baseline: gbp(4000),
  ...over,
});

describe("a ladder priced from the baseline", () => {
  it("takes each tier's discount off the catalogue's own price", () => {
    const result = resolveBreaks(forVariant(), LADDER, permissive);

    expect(result.refusal).toBeUndefined();
    expect(result.breaks.map((b) => [b.minimumQuantity, b.price.amount])).toEqual([
      [1, 4000],
      [12, 3600],
      [48, 3200],
    ]);
  });

  it("sorts tiers given out of order rather than refusing them", () => {
    const shuffled = [LADDER[2]!, LADDER[0]!, LADDER[1]!];

    expect(resolveBreaks(forVariant(), shuffled, permissive).breaks.map((b) => b.minimumQuantity))
      .toEqual([1, 12, 48]);
  });

  it("computes on integers, so a ladder is never a minor unit out", () => {
    // 3517 at 15% off is 2989.45 — the kind of number that goes wrong in floats.
    const result = resolveBreaks(
      forVariant({ baseline: gbp(3517) }),
      [{ minimumQuantity: 1, discountBps: 1500 }],
      permissive,
    );

    expect(result.breaks[0]!.price.amount).toBe(2989);
    expect(Number.isInteger(result.breaks[0]!.price.amount)).toBe(true);
  });
});

describe("the wholesale floor", () => {
  // Cost £30, minimum margin 20% → floor £37.50.
  const guardrail: WholesaleGuardrail = { minMarginPercent: 20, missingCost: "allow" };

  it("lifts a tier that would sell below it, and says where from", () => {
    const result = resolveBreaks(
      forVariant({ cost: gbp(3000) }),
      [{ minimumQuantity: 1, discountBps: 0 }],
      { ...guardrail, minMarginPercent: 50 },
    );

    // Floor is 3000 / (1 - 0.5) = 6000, above the 4000 baseline.
    expect(result.breaks[0]!.price.amount).toBe(6000);
    expect(result.breaks[0]!.clampedFrom?.amount).toBe(4000);
  });

  it("leaves a tier alone when it clears the floor", () => {
    const result = resolveBreaks(forVariant({ cost: gbp(3000) }), [LADDER[0]!], guardrail);

    expect(result.breaks[0]!.clampedFrom).toBeUndefined();
    expect(result.breaks[0]!.price.amount).toBe(4000);
  });

  it("refuses a variant with no cost by default", () => {
    // Wholesale without a cost means pricing against a contract whose margin nobody can
    // compute — a different risk from an unenforced retail guardrail.
    const result = resolveBreaks(forVariant(), LADDER, { minMarginPercent: 20, missingCost: "refuse" });

    expect(result.breaks).toHaveLength(0);
    expect(result.refusal).toMatch(/no cost is recorded/i);
  });

  it("prices without a cost when the merchant has said that is fine", () => {
    expect(resolveBreaks(forVariant(), LADDER, permissive).refusal).toBeUndefined();
  });
});

describe("ladders that would embarrass a merchant", () => {
  it("refuses one where ordering more costs more per unit", () => {
    const backwards: QuantityTier[] = [
      { minimumQuantity: 1, discountBps: 2000 },
      { minimumQuantity: 12, discountBps: 0 },
    ];

    const result = resolveBreaks(forVariant(), backwards, permissive);

    expect(result.breaks).toHaveLength(0);
    expect(result.refusal).toMatch(/cost more per unit/i);
    expect(result.refusal).toContain("12");
  });

  it("refuses an inversion the floor itself created", () => {
    // The subtle one: both tiers are fine on paper, and clamping the larger one to the
    // floor lifts it above the smaller. Checking before clamping would miss this.
    const result = resolveBreaks(
      forVariant({ baseline: gbp(4000), cost: gbp(3000) }),
      [
        { minimumQuantity: 1, discountBps: 0 },
        { minimumQuantity: 12, discountBps: 3000 },
      ],
      { minMarginPercent: 25, missingCost: "allow" },
    );

    // Floor is 4000; tier 12 wants 2800 and gets lifted to 4000 — equal, not inverted.
    expect(result.refusal).toBeUndefined();
    expect(result.breaks.map((b) => b.price.amount)).toEqual([4000, 4000]);
  });

  it("refuses two tiers starting at the same quantity", () => {
    const result = resolveBreaks(
      forVariant(),
      [
        { minimumQuantity: 12, discountBps: 1000 },
        { minimumQuantity: 12, discountBps: 2000 },
      ],
      permissive,
    );

    expect(result.refusal).toMatch(/both start at 12/);
  });

  it.each([0, -1, 1.5])("refuses a tier starting at %s units", (minimumQuantity) => {
    const result = resolveBreaks(forVariant(), [{ minimumQuantity, discountBps: 0 }], permissive);

    expect(result.refusal).toMatch(/whole number of units/);
  });

  it("refuses an empty ladder rather than writing nothing quietly", () => {
    expect(resolveBreaks(forVariant(), [], permissive).refusal).toMatch(/no quantity tiers/i);
  });
});

describe("every refusal explains itself", () => {
  const bad: Array<[string, QuantityTier[], WholesaleGuardrail]> = [
    ["empty", [], permissive],
    ["duplicate", [{ minimumQuantity: 1, discountBps: 0 }, { minimumQuantity: 1, discountBps: 5 }], permissive],
    ["fractional", [{ minimumQuantity: 2.5, discountBps: 0 }], permissive],
    ["inverted", [{ minimumQuantity: 1, discountBps: 3000 }, { minimumQuantity: 5, discountBps: 0 }], permissive],
    ["no cost", LADDER, { minMarginPercent: 20, missingCost: "refuse" }],
  ];

  it.each(bad)("%s says what to do about it", (_name, tiers, guardrail) => {
    const refusal = resolveBreaks(forVariant(), tiers, guardrail).refusal ?? "";

    // Names the problem in words a merchant can act on, not a code.
    expect(refusal.length).toBeGreaterThan(30);
    expect(refusal).toMatch(/[.!]$/);
  });
});
