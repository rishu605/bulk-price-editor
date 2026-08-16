/**
 * Guardrail floors — the machinery behind invariant I6.
 *
 * A floor is the highest of everything that applies: an absolute minimum price, cost
 * itself, and the price implied by a minimum margin. Clamping runs *after* rounding,
 * because a downward rounding profile can push an otherwise-legal price below the
 * floor.
 */

import { greaterThan, max, money, multiplyByFactor, type Money } from "../money/money";
import type { Baseline, Guardrails } from "./types";

export class MissingCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCostError";
  }
}

/**
 * Merges store and campaign guardrails. Campaign settings may only **tighten**.
 *
 * Without this rule a campaign could disable a store-wide "never below cost" policy,
 * making the store setting decorative. Loosening is possible only by changing the
 * store setting, which is a deliberate, audit-logged action.
 */
export function mergeGuardrails(store?: Guardrails, campaign?: Guardrails): Guardrails {
  if (!store) return campaign ?? {};
  if (!campaign) return store;

  return {
    // Either side may switch it on; neither may switch it off.
    neverBelowCost: store.neverBelowCost || campaign.neverBelowCost,
    minMarginPercent: pickTighter(store.minMarginPercent, campaign.minMarginPercent),
    minPrice: pickHigher(store.minPrice, campaign.minPrice),
    missingCostPolicy: campaign.missingCostPolicy ?? store.missingCostPolicy,
  };
}

function pickTighter(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function pickHigher(a?: Money, b?: Money): Money | undefined {
  if (!a) return b;
  if (!b) return a;
  return max(a, b);
}

/**
 * The effective floor for a variant, or `undefined` when nothing constrains it.
 *
 * A price is always required to be **strictly positive**, so the implicit floor is
 * one minor unit even with no guardrails configured. A zero or negative price is
 * never a legitimate outcome (edge case E10).
 *
 * @throws {MissingCostError} when a cost-dependent guardrail applies to a variant
 * with no cost and the policy is "error".
 */
export function computeFloor(
  baseline: Baseline,
  guardrails: Guardrails,
): Money | undefined {
  const candidates: Money[] = [];

  if (guardrails.minPrice) candidates.push(guardrails.minPrice);

  const needsCost =
    guardrails.neverBelowCost === true || guardrails.minMarginPercent !== undefined;

  if (needsCost && !baseline.cost) {
    if (guardrails.missingCostPolicy === "error") {
      throw new MissingCostError(
        `A cost-dependent guardrail applies but this variant has no cost per item. ` +
          `Set a cost, relax the guardrail, or use missingCostPolicy "skip".`,
      );
    }
    // "skip" (and the default) leave the cost-derived floors out; the resolver turns
    // this into a skipped variant rather than pricing it unguarded.
    return candidates.length ? candidates.reduce(max) : undefined;
  }

  if (baseline.cost) {
    if (guardrails.neverBelowCost) {
      candidates.push(baseline.cost);
    }
    if (guardrails.minMarginPercent !== undefined) {
      candidates.push(priceForMargin(baseline.cost, guardrails.minMarginPercent));
    }
  }

  if (candidates.length === 0) return undefined;
  return candidates.reduce(max);
}

/**
 * Lowest price achieving a given gross margin: `cost / (1 - margin/100)`.
 *
 * Rounds up, so the resulting price always *meets or exceeds* the target margin —
 * rounding down would produce a floor that itself violates the guardrail.
 */
export function priceForMargin(cost: Money, marginPercent: number): Money {
  if (marginPercent >= 100) {
    throw new RangeError(
      `A minimum margin of ${marginPercent}% is unreachable: margin is a share of the ` +
        `selling price, so 100% would require an infinite price.`,
    );
  }
  return multiplyByFactor(cost, 1 / (1 - marginPercent / 100), "ceil");
}

/** True when `price` sits below `floor`. */
export function violatesFloor(price: Money, floor: Money | undefined): boolean {
  if (!floor) return false;
  return greaterThan(floor, price);
}

/** Smallest strictly-positive amount in a currency: one minor unit. */
export function smallestPositive(currency: string): Money {
  return money(1, currency);
}

/** True when a cost-dependent guardrail applies but the variant has no cost. */
export function needsCostButMissing(baseline: Baseline, guardrails: Guardrails): boolean {
  const needsCost =
    guardrails.neverBelowCost === true || guardrails.minMarginPercent !== undefined;
  return needsCost && !baseline.cost;
}
