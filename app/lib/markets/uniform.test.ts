/**
 * Eligibility for the one-mutation path.
 *
 * These tests are mostly about refusing it. The saving is a nice-to-have; taking the
 * path when it does not apply reprices products the campaign never targeted, on a live
 * storefront, while reporting success. So every case below that ends in `eligible:
 * false` is worth more than the one that ends in true.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { money } from "../money/money";
import type { PlannedRow } from "../planning/types";
import {
  applyBps,
  composeBps,
  feasibleBps,
  toAdjustmentInput,
  uniformAdjustment,
} from "./uniform";

const ref = (variantGid: string) => ({
  variantGid,
  surfaceKind: "market" as const,
  priceListGid: "gid://shopify/PriceList/eu",
  currency: "EUR",
});

function row(variantGid: string, to: number, extra: Partial<PlannedRow> = {}): PlannedRow {
  return {
    ref: ref(variantGid),
    intendedPrice: money(to, "EUR"),
    intendedCompareAtSet: false,
    status: "pending",
    ...extra,
  };
}

/** A whole market, uniformly discounted: the one case that should be eligible. */
function uniformMarket(bps: number, prices: number[]) {
  const rows = prices.map((price, i) => row(`v${i}`, applyBps(price, bps)));
  const baselines = new Map(prices.map((price, i) => [`v${i}`, price]));
  const listVariantGids = new Set(prices.map((_, i) => `v${i}`));
  return { rows, baselines, listVariantGids, hasFixedOverrides: false };
}

describe("deciding whether a market can be repriced with one mutation", () => {
  it("accepts a whole market moved by one percentage", () => {
    const verdict = uniformAdjustment(uniformMarket(-2000, [1000, 2500, 9999]));
    expect(verdict).toEqual({ eligible: true, bps: -2000 });
  });

  it("refuses when one product's price does not follow the same percentage", () => {
    const input = uniformMarket(-2000, [1000, 2500, 9999]);
    // One product a single minor unit off — charm-99 rounding does exactly this, and
    // it is the difference between a market-wide percentage and a list of prices.
    input.rows[1] = row("v1", input.rows[1].intendedPrice!.amount - 1);

    const verdict = uniformAdjustment(input);
    expect(verdict.eligible).toBe(false);
  });

  it("refuses when the campaign covers only part of the market", () => {
    const input = uniformMarket(-2000, [1000, 2500]);
    input.listVariantGids.add("v-not-in-scope");

    const verdict = uniformAdjustment(input);
    // The reason has to name the numbers. This is the refusal that saves a merchant
    // from having their whole catalogue repriced, and "not eligible" would tell them
    // nothing about why.
    expect(verdict).toMatchObject({ eligible: false });
    if (!verdict.eligible) expect(verdict.reason).toContain("2 of the 3 products");
  });

  it("refuses when the market has prices set on individual products", () => {
    const verdict = uniformAdjustment({
      ...uniformMarket(-2000, [1000, 2500]),
      hasFixedOverrides: true,
    });

    expect(verdict.eligible).toBe(false);
  });

  it("refuses a strike-through, which a market-wide percentage cannot express", () => {
    const input = uniformMarket(-2000, [1000, 2500]);
    input.rows[0] = row("v0", input.rows[0].intendedPrice!.amount, {
      intendedCompareAt: money(1000, "EUR"),
      intendedCompareAtSet: true,
    });

    const verdict = uniformAdjustment(input);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) expect(verdict.reason).toContain("strike-through");
  });

  it("refuses when a product was skipped rather than repriced", () => {
    const input = uniformMarket(-2000, [1000, 2500]);
    input.rows[0] = { ...input.rows[0], status: "skipped" };

    // Worse than merely ineligible: a market-wide percentage would reprice the skipped
    // product anyway, doing the exact thing the plan decided against.
    expect(uniformAdjustment(input).eligible).toBe(false);
  });

  it("refuses when a product was clamped to a guardrail", () => {
    const input = uniformMarket(-2000, [1000, 2500]);
    input.rows[0] = { ...input.rows[0], status: "clamped" };

    expect(uniformAdjustment(input).eligible).toBe(false);
  });

  it("refuses a campaign that changes nothing", () => {
    expect(uniformAdjustment(uniformMarket(0, [1000, 2500])).eligible).toBe(false);
  });

  it("refuses when there is nothing to price", () => {
    expect(
      uniformAdjustment({
        rows: [],
        baselines: new Map(),
        listVariantGids: new Set(),
        hasFixedOverrides: false,
      }).eligible,
    ).toBe(false);
  });

  it("does not let a cheap product decide the percentage", () => {
    // The bug this replaces: the percentage was recovered from whichever row came
    // first. At a baseline of 7 minor units a 20% cut is 6, and the only percentage
    // that reproduces 6 from 7 is -14.29% — which then fails to reproduce anything
    // else, so a perfectly uniform campaign was rejected whenever a cheap product
    // happened to sort first. It made the whole optimisation a coin flip on catalogue
    // order, and it passed locally purely because one seed's catalogue was lucky.
    const verdict = uniformAdjustment(uniformMarket(-2000, [7, 1000, 250_000]));

    expect(verdict).toEqual({ eligible: true, bps: -2000 });
  });

  it("still rejects a genuinely non-uniform change in a catalogue of mixed prices", () => {
    // The looser derivation must not become a looser *decision*. Perturbing a middle
    // product rather than the dearest one, because a small nudge to the dearest is
    // reproducible by a slightly different percentage and is therefore still uniform —
    // correctly eligible, just at -19.96% rather than -20%. This one no single
    // percentage can produce.
    const input = uniformMarket(-2000, [7, 1000, 250_000]);
    input.rows[1] = row("v1", 900);

    expect(uniformAdjustment(input).eligible).toBe(false);
  });

  it("accepts a markup as readily as a discount", () => {
    expect(uniformAdjustment(uniformMarket(1500, [1000, 2500]))).toEqual({
      eligible: true,
      bps: 1500,
    });
  });
});

describe("composing the campaign's percentage with the market's own", () => {
  it("does not throw the merchant's existing adjustment away", () => {
    // A market 10% below base, discounted a further 20%, sits 28% below base — not
    // 20%. Writing -20% would raise every price in that market by 8% while the ledger
    // insisted the campaign applied correctly.
    expect(composeBps(-1000, -2000)).toBe(-2800);
  });

  it("is the identity when the market has no adjustment of its own", () => {
    expect(composeBps(0, -2000)).toBe(-2000);
  });

  it("handles a market that sits above the base price", () => {
    expect(composeBps(2000, -2000)).toBe(-400);
  });
});

describe("converting basis points for the Admin API", () => {
  it("splits the sign into Shopify's two adjustment types", () => {
    expect(toAdjustmentInput(-2000)).toEqual({ type: "PERCENTAGE_DECREASE", value: 20 });
    expect(toAdjustmentInput(1500)).toEqual({ type: "PERCENTAGE_INCREASE", value: 15 });
  });

  it("keeps a fractional percentage that basis points can express", () => {
    expect(toAdjustmentInput(-1233)).toEqual({ type: "PERCENTAGE_DECREASE", value: 12.33 });
  });

  it("serialises without floating-point noise", () => {
    // The API takes a Float, so the value is a float exactly once, here at the
    // boundary. What matters is that JSON carries the shortest round-trip form:
    // "12.33", not "12.329999999999998".
    for (let bps = -9999; bps < 0; bps += 7) {
      expect(JSON.stringify(toAdjustmentInput(bps).value)).toBe(String(Math.abs(bps) / 100));
    }
  });
});

describe("applying a percentage in integer minor units", () => {
  it("never produces a fractional minor unit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: -9_900, max: 10_000 }),
        (minorUnits, bps) => {
          expect(Number.isInteger(applyBps(minorUnits, bps))).toBe(true);
        },
      ),
    );
  });

  it("rounds a discount and a markup of the same size symmetrically", () => {
    // Asymmetric rounding would make a campaign and its reverse disagree by a minor
    // unit, which is how a revert drifts.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 5_000 }), (price, bps) => {
        expect(applyBps(-price, -bps)).toBe(-applyBps(price, -bps));
      }),
    );
  });
});

describe("recovering the percentage from prices that were rounded", () => {
  it("finds -20% when the dearest product's cut did not land on a whole minor unit", () => {
    // The exact catalogue that failed under CHAOS_SEED=20261119, and the reason the
    // market-wide path was a lottery. 20% off 7,088 is 5,670.4, stored as 5,670, which
    // recovers as -2001 bps — and -2001 then reproduces almost nothing else, so forty
    // products got forty writes instead of one mutation.
    //
    // Picking the dearest product was the previous fix. It narrowed the recovery error
    // and could not remove it: any target that is not an exact multiple still rounds.
    const verdict = uniformAdjustment(
      uniformMarket(-2000, [7088, 6955, 4504, 3047, 2451, 1590, 994, 662]),
    );

    expect(verdict).toEqual({ eligible: true, bps: -2000 });
  });

  it("finds the round percentage even when every single row was rounded", () => {
    // Baselines chosen so that a 15% cut lands on a half in every case. There is no row
    // to recover an exact answer from, which is precisely when guessing from one row
    // fails and intersecting intervals still works.
    const verdict = uniformAdjustment(uniformMarket(-1500, [110, 130, 150, 170, 190]));

    expect(verdict).toEqual({ eligible: true, bps: -1500 });
  });

  it("still refuses a plan that is genuinely not one percentage", () => {
    // The property that matters far more than the optimisation. A parent adjustment
    // reprices the entire list, so admitting a plan that is not uniform would move
    // products the campaign never targeted, on a live storefront, and report success.
    const market = uniformMarket(-2000, [7088, 6955, 4504, 3047]);
    // One product clamped by a guardrail to something no percentage explains.
    market.rows[2] = row("v2", 4000);

    expect(uniformAdjustment(market)).toEqual({
      eligible: false,
      reason: "the change is not the same percentage on every product",
    });
  });

  it("does not admit an adjustment that rounds away from the target", () => {
    // The exclusive upper bound, which is reachable on round numbers: a baseline of 200
    // at -2500 bps lands on exactly 150.0, and 150.5 would round to 151. Off by one here
    // either loses a legitimate adjustment or admits one that reprices a market wrongly.
    const verdict = uniformAdjustment(uniformMarket(-2500, [200, 400, 800]));

    expect(verdict).toEqual({ eligible: true, bps: -2500 });
  });

  it("agrees with applyBps on every row it admits", () => {
    // The invariant behind the whole check, asserted over arbitrary catalogues rather
    // than chosen ones: if a percentage is returned, it must reproduce every price the
    // plan asked for. Anything less is a market repriced to something nobody chose.
    fc.assert(
      fc.property(
        fc.integer({ min: -9_000, max: 9_000 }),
        fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 30 }),
        (bps, baselines) => {
          const market = uniformMarket(bps, baselines);
          const verdict = uniformAdjustment(market);

          if (!verdict.eligible) return;

          for (const [index, baseline] of baselines.entries()) {
            expect(applyBps(baseline, verdict.bps)).toBe(
              market.rows[index].intendedPrice!.amount,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("feasibleBps", () => {
  it("excludes an adjustment that lands exactly on the rounding boundary", () => {
    // 6 → 4 admits every adjustment down to, but not including, -2500: at exactly -2500
    // the price is 4.5, and half-up rounding sends that to 5. Admitting it would move
    // every product in the market by a minor unit.
    expect(applyBps(6, -2500)).toBe(5);
    expect(feasibleBps(6, 4).hi).toBe(-2501);
    expect(applyBps(6, -2501)).toBe(4);
  });

  it("includes the whole band that does round to the target", () => {
    const { lo, hi } = feasibleBps(7088, 5670);

    // The seed-20261119 row. Both the value the old code guessed and the one the campaign
    // actually asked for are in here, which is exactly why intersecting works and
    // guessing from one row does not.
    expect(lo).toBe(-2001);
    expect(hi).toBe(-2000);

    expect(applyBps(7088, lo)).toBe(5670);
    expect(applyBps(7088, hi)).toBe(5670);
    expect(applyBps(7088, lo - 1)).not.toBe(5670);
    expect(applyBps(7088, hi + 1)).not.toBe(5670);
  });

  it("agrees with applyBps at both ends, for arbitrary prices", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: -9_000, max: 9_000 }),
        (baseline, bps) => {
          const to = applyBps(baseline, bps);
          const { lo, hi } = feasibleBps(baseline, to);

          // The band is exactly the set that produces `to`: both ends do, and stepping
          // one past either end does not.
          expect(applyBps(baseline, lo)).toBe(to);
          expect(applyBps(baseline, hi)).toBe(to);
          expect(lo).toBeLessThanOrEqual(bps);
          expect(hi).toBeGreaterThanOrEqual(bps);
          expect(applyBps(baseline, hi + 1)).not.toBe(to);

          // Except at the -100% floor, which is a deliberate stop rather than the edge
          // of the rounding band — below it the price is negative and the question is
          // meaningless.
          if (lo > -10_000) expect(applyBps(baseline, lo - 1)).not.toBe(to);
        },
      ),
      { numRuns: 500 },
    );
  });
});
