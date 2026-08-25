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
import { applyBps, composeBps, toAdjustmentInput, uniformAdjustment } from "./uniform";

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
