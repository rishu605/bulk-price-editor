/**
 * Deciding whether a market can be repriced with one mutation instead of hundreds.
 *
 * A price list with a parent adjustment derives every price from a single percentage.
 * When a campaign happens to want exactly that, setting the parent is one call rather
 * than one chunk per 250 variants — the difference between a market repricing in a
 * second and one repricing over several minutes.
 *
 * The saving is real and the failure is severe, because a parent adjustment reprices
 * the *whole list*. A campaign scoped to forty products that took this path would
 * reprice the merchant's entire Japanese catalogue. So eligibility is proven, never
 * predicted.
 *
 * Proven from the plan, specifically — not from the rule. Reading the rule and
 * reasoning "this is a uniform 20% off, therefore uniform" is wrong in at least four
 * ways that all look fine in the rule: charm-99 rounding perturbs individual prices, a
 * guardrail clamps some of them, another campaign wins some variants, and a variant
 * reverted out individually is excluded. Each produces a plan that is *not* uniform
 * from a rule that reads as though it is. Checking the finished plan catches all four
 * without knowing about any of them, and will catch the fifth we have not thought of.
 */

import type { PlannedRow } from "../planning/types";

export type UniformVerdict =
  | {
      eligible: true;
      /** The adjustment, in basis points. Negative is a discount. */
      bps: number;
    }
  | { eligible: false; reason: string };

export interface UniformInputs {
  /** Every row the plan produced for this market, in any status. */
  rows: readonly PlannedRow[];
  /**
   * Each variant's baseline on this market, in that market's minor units.
   *
   * Passed rather than read from the row, because a planned row's `beforePrice` is
   * the *live* value and a relative price list has no mirrored live value at all. The
   * percentage a parent adjustment expresses is measured from the baseline.
   */
  baselines: ReadonlyMap<string, number>;
  /**
   * Variants the price list itself covers.
   *
   * The campaign must cover all of them. A parent adjustment does not know about
   * scope, so pricing a subset through it silently reprices the rest.
   */
  listVariantGids: ReadonlySet<string>;
  /**
   * Whether the list already has per-variant fixed prices.
   *
   * A fixed price shadows the parent adjustment, so those variants would keep their
   * old price while every other one moved — a half-applied campaign that reports as
   * fully applied.
   */
  hasFixedOverrides: boolean;
}

export function uniformAdjustment(inputs: UniformInputs): UniformVerdict {
  const { rows, baselines, listVariantGids, hasFixedOverrides } = inputs;

  if (rows.length === 0) return { eligible: false, reason: "there is nothing to price" };

  if (hasFixedOverrides) {
    return {
      eligible: false,
      reason:
        "this market has prices set on individual products, which would override a " +
        "market-wide percentage and leave those products at their old price",
    };
  }

  // A skipped or clamped row is by definition not part of a uniform change — and a
  // skipped row is worse than merely ineligible, because the parent adjustment would
  // reprice it anyway, doing the exact thing the plan decided not to do.
  const unusable = rows.find((row) => row.status !== "pending");
  if (unusable) {
    return {
      eligible: false,
      reason: `at least one product is ${unusable.status} rather than simply repriced`,
    };
  }

  // Compare-at cannot be expressed. The parent's compareAtMode either adjusts the
  // compare-at by the same percentage or nullifies it; neither is "set the compare-at
  // to what the price used to be", which is what a strike-through sale means. Taking
  // this path for a sale would apply the right price with no strike-through at all,
  // and the strike-through is the entire point of the sale.
  if (rows.some((row) => row.intendedCompareAtSet)) {
    return {
      eligible: false,
      reason: "a strike-through price has to be set per product",
    };
  }

  if (rows.length !== listVariantGids.size) {
    return {
      eligible: false,
      reason:
        `this campaign covers ${rows.length} of the ${listVariantGids.size} products ` +
        "on this market, and a market-wide percentage would reprice all of them",
    };
  }

  const covered = new Set(rows.map((row) => row.ref.variantGid));
  for (const gid of listVariantGids) {
    if (!covered.has(gid)) {
      return {
        eligible: false,
        reason:
          "this campaign does not cover every product on this market, and a " +
          "market-wide percentage would reprice the ones it misses",
      };
    }
  }

  const priced: Array<{ baseline: number; to: number }> = [];

  for (const row of rows) {
    const baseline = baselines.get(row.ref.variantGid);
    const to = row.intendedPrice?.amount;

    if (baseline === undefined || to === undefined) {
      return { eligible: false, reason: "a product has no price to compare against" };
    }
    if (baseline === 0) {
      return { eligible: false, reason: "a product is priced at zero, which has no percentage" };
    }

    priced.push({ baseline, to });
  }

  // Derived from the *dearest* product, then verified against every other one.
  //
  // Not the first, which is what this did originally and which made the whole
  // optimisation a coin flip on catalogue order. Recovering a percentage from a cheap
  // product is imprecise: at a baseline of 7 minor units a 20% cut is 6, and the only
  // percentage that reproduces 6 from 7 is -14.29%, which then fails to reproduce
  // anything else. The dearest product carries the most significant digits, so the
  // percentage it implies is the one most likely to be the campaign's actual intent.
  //
  // It is still only a candidate. Every row has to reproduce exactly, so a wrong guess
  // costs the optimisation and never a wrong price.
  const strongest = priced.reduce((best, row) => (row.baseline > best.baseline ? row : best));
  const bps = Math.round(((strongest.to - strongest.baseline) * 10_000) / strongest.baseline);

  for (const row of priced) {
    if (applyBps(row.baseline, bps) !== row.to) {
      return {
        eligible: false,
        reason: "the change is not the same percentage on every product",
      };
    }
  }

  if (bps === 0) {
    return { eligible: false, reason: "the campaign does not change this market's prices" };
  }

  return { eligible: true, bps };
}

/**
 * A percentage applied to minor units, in integers.
 *
 * The same rounding Shopify performs, so the eligibility check compares like with
 * like. Half-up on the absolute value, so a discount and a markup of the same size
 * round symmetrically rather than drifting apart around zero.
 */
export function applyBps(minorUnits: number, bps: number): number {
  const scaled = (minorUnits * (10_000 + bps)) / 10_000;
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/**
 * Two adjustments in sequence, as one.
 *
 * A relative price list's baseline is already the converted base price with the list's
 * own percentage applied. So a campaign taking 20% off a market that already sits 10%
 * below the base price does not want a parent adjustment of -20% — that would throw
 * the merchant's own 10% away. It wants -28%: the two composed.
 *
 * Getting this wrong is not a rounding error, it is a different price. On the example
 * above the market would land 8% higher than the campaign asked for, on every product,
 * with the ledger insisting the campaign was applied correctly.
 */
export function composeBps(existingBps: number, campaignBps: number): number {
  return Math.round(((10_000 + existingBps) * (10_000 + campaignBps)) / 10_000) - 10_000;
}

/**
 * Basis points as the Admin API's `PriceListAdjustmentInput` wants them.
 *
 * The API takes a Float, which is why the value is stored as an integer everywhere
 * else and converted only here, at the boundary. A percentage is not money, so this
 * does not breach the no-floats rule — but the conversion still belongs in one named
 * place rather than scattered as `bps / 100` through the call sites.
 */
export function toAdjustmentInput(bps: number): { type: string; value: number } {
  return {
    type: bps < 0 ? "PERCENTAGE_DECREASE" : "PERCENTAGE_INCREASE",
    value: Math.abs(bps) / 100,
  };
}
