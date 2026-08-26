/**
 * The resolver. One pure function, four consumers:
 *
 *   preview        renders its output
 *   the planner    diffs it against live values to build ledger rows
 *   revert         calls it with the ending campaign removed
 *   reconciliation compares live values against it
 *
 * One implementation means a preview can never disagree with what execution does.
 *
 * Order of operations is deliberate and load-bearing:
 *
 *   baseline -> rule -> round -> clamp -> compare-at
 *
 * Rounding before clamping, because a downward rounding profile can push a legal
 * price below a guardrail floor; clamping last guarantees invariant I6 holds on the
 * value actually written.
 */

import { profileFor } from "../money/rounding-policy";
import { applyRounding } from "../money/rounding";
import { isPositive, lessThanOrEqual, max, type Money } from "../money/money";
import {
  computeFloor,
  MissingCostError,
  mergeGuardrails,
  needsCostButMissing,
  smallestPositive,
  violatesFloor,
} from "./guardrails";
import { applyRule, RuleNotApplicableError, selectRule } from "./rules";
import type {
  CompareAtPolicy,
  Resolution,
  ResolvableCampaign,
  ResolveInput,
} from "./types";

/**
 * Picks the campaign controlling a variant. Never stacks — exactly one wins.
 *
 * Order: highest priority, then latest start, then largest id. The id tie-break
 * exists so the ordering is *total*: two campaigns created in the same millisecond
 * with equal priority must still resolve deterministically, or preview and execution
 * could disagree.
 */
export function selectWinner(
  campaigns: ResolvableCampaign[],
): ResolvableCampaign | undefined {
  if (campaigns.length === 0) return undefined;

  return campaigns.reduce((best, candidate) =>
    compareCampaigns(candidate, best) > 0 ? candidate : best,
  );
}

/** Positive when `a` outranks `b`. Total and stable. */
export function compareCampaigns(a: ResolvableCampaign, b: ResolvableCampaign): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.startAt !== b.startAt) return a.startAt - b.startAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function resolve(input: ResolveInput): Resolution {
  const { baseline, surface, campaigns, storeGuardrails, variantSegmentIds } = input;
  const currency = surface.currency;

  const winner = selectWinner(campaigns);

  // Nothing controls this variant: it sits at its baseline.
  //
  // Baseline values pass through unvalidated, deliberately. A merchant may already
  // have a compare-at at or below their price; that is their data, not something we
  // computed, and this same path is what a revert writes -- where faithfully
  // restoring the original state is the entire point. Compare-at validation applies
  // to values this resolver produces (see resolveCompareAt), not to pre-existing ones.
  if (!winner) {
    return {
      price: baseline.price,
      compareAtPrice: baseline.compareAtPrice ?? null,
      meta: { outcome: "baseline", clamped: false },
    };
  }

  const guardrails = mergeGuardrails(storeGuardrails, winner.guardrails);

  // A cost-dependent guardrail with no cost cannot be evaluated. Pricing anyway
  // would mean writing a price the merchant explicitly asked us to guard.
  if (needsCostButMissing(baseline, guardrails)) {
    if (guardrails.missingCostPolicy === "error") {
      return blocked(winner, "missing-cost");
    }
    return skipped(winner, "missing-cost");
  }

  const rule = selectRule(winner.ruleRows, variantSegmentIds);
  if (!rule) {
    // No rule row matched. The campaign does not price this variant.
    return {
      price: baseline.price,
      compareAtPrice: baseline.compareAtPrice ?? null,
      meta: { outcome: "baseline", clamped: false },
    };
  }

  let unrounded: Money;
  try {
    unrounded = applyRule(rule, baseline, { importedPrices: input.importedPrices });
  } catch (error) {
    if (error instanceof RuleNotApplicableError) {
      const reason =
        error.reason === "invalid-margin"
          ? "invalid-margin"
          : error.reason === "missing-import"
            ? "missing-import"
            : "missing-cost";
      return winner.guardrailViolationPolicy === "block"
        ? blocked(winner, reason, rule)
        : skipped(winner, reason, rule);
    }
    throw error;
  }

  // Rounded in the currency actually being written, not the store's. The same campaign
  // rounds dollars to .99 and yen to the nearest ten, because that is what each looks
  // right in — which is the entire point of pricing per market.
  const rounded = applyRounding(unrounded, profileFor(winner.roundingPolicy, currency));

  let floor: Money | undefined;
  try {
    floor = computeFloor(baseline, guardrails);
  } catch (error) {
    if (error instanceof MissingCostError) return blocked(winner, "missing-cost", rule);
    throw error;
  }

  // A price must always be strictly positive, guardrails or not (edge case E10).
  const effectiveFloor = floor ? max(floor, smallestPositive(currency)) : undefined;

  let price = rounded;
  let clamped = false;

  if (violatesFloor(price, effectiveFloor)) {
    switch (winner.guardrailViolationPolicy) {
      case "block":
        return blocked(winner, "below-floor", rule, effectiveFloor, unrounded);
      case "skip":
        return skipped(winner, "below-floor", rule, effectiveFloor, unrounded);
      case "clamp":
        price = effectiveFloor as Money;
        clamped = true;
        break;
    }
  }

  // With no guardrails configured there is no floor, but a non-positive price is
  // still never a legitimate outcome.
  if (!isPositive(price)) {
    switch (winner.guardrailViolationPolicy) {
      case "block":
        return blocked(winner, "non-positive-price", rule, effectiveFloor, unrounded);
      case "skip":
        return skipped(winner, "non-positive-price", rule, effectiveFloor, unrounded);
      case "clamp":
        price = smallestPositive(currency);
        clamped = true;
        break;
    }
  }

  const compareAt = resolveCompareAt(winner, baseline, price);

  if (compareAt.blocked) {
    return blocked(winner, "invalid-compare-at", rule, effectiveFloor, unrounded);
  }
  if (compareAt.skipVariant) {
    return skipped(winner, "invalid-compare-at", rule, effectiveFloor, unrounded);
  }

  return {
    price,
    compareAtPrice: compareAt.value,
    meta: {
      outcome: "priced",
      controlledBy: winner.id,
      appliedRule: rule,
      clamped,
      floor: effectiveFloor,
      unroundedPrice: unrounded,
    },
  };
}

interface CompareAtOutcome {
  /** `undefined` leaves it untouched; `null` clears it. */
  value?: Money | null;
  skipVariant?: boolean;
  blocked?: boolean;
}

/**
 * Applies the compare-at policy and validates the result.
 *
 * A compare-at at or below the price renders as a strike-through that shows no
 * saving — or worse, an apparent price increase. Competitors ship this bug; a
 * one-star review on one of them is exactly this complaint, so it is validated
 * rather than trusted (edge case E11).
 */
function resolveCompareAt(
  campaign: ResolvableCampaign,
  baseline: { price: Money; compareAtPrice?: Money; cost?: Money },
  finalPrice: Money,
): CompareAtOutcome {
  const policy: CompareAtPolicy = campaign.compareAtPolicy;

  let candidate: Money | null | undefined;

  switch (policy.kind) {
    case "leave":
      return { value: undefined };

    case "clear":
      return { value: null };

    case "set-to-baseline":
      candidate = baseline.price;
      break;

    case "adjust": {
      if (!baseline.compareAtPrice) {
        // Nothing to adjust. Leaving it alone is the least surprising outcome.
        return { value: undefined };
      }
      try {
        candidate = applyRule(policy.rule, baseline);
      } catch (error) {
        if (error instanceof RuleNotApplicableError) return { value: undefined };
        throw error;
      }
      break;
    }
  }

  if (candidate == null) return { value: candidate };

  // Must strictly exceed the price to display a genuine saving.
  if (lessThanOrEqual(candidate, finalPrice)) {
    switch (campaign.compareAtViolationPolicy) {
      case "block":
        return { blocked: true };
      case "skip":
        return { skipVariant: true };
      case "clear":
        return { value: null };
    }
  }

  return { value: candidate };
}

function skipped(
  campaign: ResolvableCampaign,
  reason: Resolution["meta"]["reason"],
  rule?: Resolution["meta"]["appliedRule"],
  floor?: Money,
  unroundedPrice?: Money,
): Resolution {
  return {
    meta: {
      outcome: "skipped",
      controlledBy: campaign.id,
      appliedRule: rule,
      clamped: false,
      floor,
      reason,
      unroundedPrice,
    },
  };
}

function blocked(
  campaign: ResolvableCampaign,
  reason: Resolution["meta"]["reason"],
  rule?: Resolution["meta"]["appliedRule"],
  floor?: Money,
  unroundedPrice?: Money,
): Resolution {
  return {
    meta: {
      outcome: "blocked",
      controlledBy: campaign.id,
      appliedRule: rule,
      clamped: false,
      floor,
      reason,
      unroundedPrice,
    },
  };
}

/**
 * Resolution with a campaign removed — what "revert" means.
 *
 * Reverting is *not* restoring saved numbers. If a lower-priority campaign is still
 * running, blind restore would put full price back on a storefront that should still
 * be on sale; if the baseline moved via drift adoption, it would reinstate a stale
 * number. Recomputing handles overlap, recurrence and partial failure with one
 * mechanism. This is invariant I3.
 */
export function resolveWithout(input: ResolveInput, campaignId: string): Resolution {
  return resolve({
    ...input,
    campaigns: input.campaigns.filter((c) => c.id !== campaignId),
  });
}

/** True when two resolutions would write the same values — used to skip no-ops. */
export function isSameOutcome(a: Resolution, b: Resolution): boolean {
  const samePrice =
    (a.price === undefined && b.price === undefined) ||
    (a.price !== undefined &&
      b.price !== undefined &&
      a.price.amount === b.price.amount &&
      a.price.currency === b.price.currency);

  // `undefined` (leave alone) and `null` (clear) are different instructions, so they
  // must not compare equal.
  const sameCompareAt =
    a.compareAtPrice === b.compareAtPrice ||
    (a.compareAtPrice != null &&
      b.compareAtPrice != null &&
      a.compareAtPrice.amount === b.compareAtPrice.amount &&
      a.compareAtPrice.currency === b.compareAtPrice.currency);

  return samePrice && sameCompareAt;
}
