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

  // Every basis-point value that reproduces every row, found exactly rather than guessed.
  //
  // The obvious approach — recover a percentage from one row and check the others —
  // cannot work, because the row's price was rounded to a minor unit before we saw it and
  // the rounding is amplified back into the percentage. A clean 20% off a baseline of
  // 7,088 is 5,670.4, stored as 5,670, which recovers as -20.01% and then reproduces
  // almost nothing else. Picking the dearest row narrowed that error; it did not remove
  // it, and one basis point out is as useless as a hundred.
  //
  // So take the question the other way round. `applyBps` rounds, so for a given row the
  // set of values that map its baseline to its target is an *interval*:
  //
  //     round(baseline × (10000 + bps) / 10000) == to
  //       ⟺  to - 0.5  ≤  baseline × (10000 + bps) / 10000  <  to + 0.5
  //
  // For the row above that interval is [-2001, -2000] — it holds the wrong answer and the
  // right one. Intersecting the intervals across every row leaves only values that
  // reproduce all of them at once. Exact, one pass, and no heuristic about which product
  // to trust.
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;

  for (const row of priced) {
    const span = feasibleBps(row.baseline, row.to);
    lo = Math.max(lo, span.lo);
    hi = Math.min(hi, span.hi);

    // An empty intersection means no single percentage produces these prices, which is
    // what a plan perturbed by charm rounding or a guardrail actually looks like. The
    // optimisation is lost and the prices are still right, which is the correct trade.
    if (lo > hi) {
      return {
        eligible: false,
        reason: "the change is not the same percentage on every product",
      };
    }
  }

  // Any value in the range reproduces every row, so the choice is about meaning rather
  // than correctness. It still matters: this number is written to the merchant's price
  // list and they read it in the Shopify admin, where "-14.74%" next to a campaign they
  // set up as "15% off" is alarming in a way that takes a support ticket to settle.
  const strongest = priced.reduce((best, row) => (row.baseline > best.baseline ? row : best));
  const intent = ((strongest.to - strongest.baseline) * 10_000) / strongest.baseline;
  const bps = roundestWithin(lo, hi, intent);

  if (bps === 0) {
    return { eligible: false, reason: "the campaign does not change this market's prices" };
  }

  return { eligible: true, bps };
}

/**
 * The value in `[lo, hi]` a person would recognise as the percentage they asked for.
 *
 * Merchants set whole percentages, so a whole percentage in range is almost certainly
 * what this campaign is. Nearest-to-implied is not good enough on its own: five prices
 * that all round up push the implied figure well off the real one — a clean 15% off a
 * catalogue of 110 to 190 minor units implies -14.74%, and every price still reproduces
 * exactly from -15%.
 *
 * Coarsest step that lands in range wins, then nearest to the implied value among the
 * multiples of that step. Correctness is not at stake here — every value in the range
 * reproduces every row, which is what makes preferring the legible one free.
 */
function roundestWithin(lo: number, hi: number, intent: number): number {
  for (const step of [100, 50, 25, 10, 5, 1]) {
    const first = Math.ceil(lo / step) * step;
    const last = Math.floor(hi / step) * step;
    if (first > last) continue;

    return Math.min(last, Math.max(first, Math.round(intent / step) * step));
  }

  // Unreachable: a non-empty range always contains a multiple of 1. Present so the
  // function has a total return rather than relying on the reader to prove it.
  return Math.min(hi, Math.max(lo, Math.round(intent)));
}

/**
 * The basis-point values that map `baseline` to `to`, as an inclusive integer range.
 *
 * Derived from `applyBps`'s rounding rather than assumed, so the two cannot drift apart:
 * a target price of `to` is produced by any adjustment landing in [to - 0.5, to + 0.5),
 * and that band in prices is a band in basis points.
 *
 * The upper bound is exclusive in prices, so an adjustment landing exactly on `to + 0.5`
 * rounds up and away. Handled explicitly because it is reachable — a baseline of 6 with a
 * target of 4 admits -2500 unless the boundary is excluded, and -2500 turns 6 into 4.5,
 * which rounds to 5. One minor unit, on every product in a market.
 *
 * Exported for its own tests. The market fixtures cannot reach this cleanly: the
 * intersection of several rows almost always excludes the boundary anyway, and
 * `roundestWithin` prefers a legible value over an extreme one — so a market test can
 * pass with the bound wrong. A boundary this exact deserves to be checked exactly.
 */
export function feasibleBps(baseline: number, to: number): { lo: number; hi: number } {
  // Floored at -100%. Below that the arithmetic keeps working and stops meaning
  // anything: the price goes negative, `applyBps` reflects it through zero, and a
  // baseline of 1 with a target of 0 acquires a "feasible" band stretching to -150%.
  // Shopify has no such adjustment either, so the floor costs nothing real.
  const lo = Math.max(-10_000, Math.ceil(((to - 0.5) * 10_000) / baseline - 10_000));

  const exclusive = ((to + 0.5) * 10_000) / baseline - 10_000;
  const hi = Number.isInteger(exclusive) ? exclusive - 1 : Math.floor(exclusive);

  return { lo, hi };
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
