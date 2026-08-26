/**
 * The rule engine: baseline + rule -> an unrounded price.
 *
 * Every rule reads the baseline (or cost, or baseline compare-at). None reads the
 * current live price, which is what makes re-running a campaign idempotent.
 */

import {
  add,
  applyPercentChange,
  money,
  multiplyByFactor,
  type Money,
} from "../money/money";
import type { AdjustmentRule, Baseline, RuleRow } from "./types";

/** Per-variant inputs a rule may need that the baseline does not carry. */
export interface RuleContext {
  importedPrices?: Record<string, Money>;
}

export class RuleNotApplicableError extends Error {
  constructor(
    readonly reason:
      | "missing-cost"
      | "missing-compare-at"
      | "invalid-margin"
      /** The imported file did not name this variant. */
      | "missing-import",
    message: string,
  ) {
    super(message);
    this.name = "RuleNotApplicableError";
  }
}

/**
 * Selects the rule for a variant: the **last** matching row wins.
 *
 * Rows with no segment ids apply to the whole campaign scope. Last-wins gives a
 * total, deterministic order for overlapping rows rather than an error the merchant
 * would have to resolve mid-campaign (edge case E16).
 */
export function selectRule(
  ruleRows: RuleRow[],
  variantSegmentIds: string[] = [],
): AdjustmentRule | undefined {
  const segments = new Set(variantSegmentIds);
  let selected: AdjustmentRule | undefined;

  for (const row of ruleRows) {
    const matches =
      row.segmentIds.length === 0 || row.segmentIds.some((id) => segments.has(id));
    if (matches) selected = row.rule;
  }

  return selected;
}

/**
 * Computes the unrounded price for a rule.
 *
 * @throws {RuleNotApplicableError} when required inputs are absent. Cost-based rules
 * on a variant with no cost must never silently treat cost as zero — that would
 * price the item at nothing and report success.
 */
export function applyRule(
  rule: AdjustmentRule,
  baseline: Baseline,
  /** Per-variant inputs a rule may need that the baseline does not carry. */
  context: RuleContext = {},
): Money {
  switch (rule.kind) {
    case "percent-change":
      return applyPercentChange(baseline.price, rule.percent);

    case "fixed-change":
      return add(baseline.price, rule.amount);

    case "set-exact":
      return rule.amount;

    case "from-import": {
      const price = context.importedPrices?.[rule.importId];
      // A variant the file did not mention. Not an error and not zero: this campaign
      // simply does not price it, and reporting that is what the skipped count is for.
      if (!price) throw new RuleNotApplicableError("missing-import", rule.kind);
      return price;
    }

    case "from-cost-multiplier": {
      const cost = requireCost(baseline, "from-cost-multiplier");
      return multiplyByFactor(cost, rule.factor);
    }

    case "from-cost-margin": {
      const cost = requireCost(baseline, "from-cost-margin");
      // Gross margin is a percentage of the selling price, so
      //   margin = (price - cost) / price   =>   price = cost / (1 - margin/100).
      // At 100% the divisor is zero and the price is unbounded; above it, negative.
      if (rule.marginPercent >= 100 || rule.marginPercent <= -Infinity) {
        throw new RuleNotApplicableError(
          "invalid-margin",
          `A target margin of ${rule.marginPercent}% is unreachable: margin is a share of ` +
            `the selling price, so 100% would require an infinite price.`,
        );
      }
      return multiplyByFactor(cost, 1 / (1 - rule.marginPercent / 100));
    }

    case "percent-of-compare-at": {
      if (!baseline.compareAtPrice) {
        throw new RuleNotApplicableError(
          "missing-compare-at",
          `Rule "percent-of-compare-at" needs a baseline compare-at price, and this ` +
            `variant has none.`,
        );
      }
      return applyPercentChange(baseline.compareAtPrice, rule.percent);
    }
  }

  // Unreachable for well-typed input; guards against a future rule kind slipping
  // through unhandled and silently returning the baseline.
  throw new RuleNotApplicableError(
    "invalid-margin",
    `Unhandled rule kind: ${(rule as { kind: string }).kind}`,
  );
}

function requireCost(baseline: Baseline, ruleKind: string): Money {
  if (!baseline.cost) {
    throw new RuleNotApplicableError(
      "missing-cost",
      `Rule "${ruleKind}" needs a cost per item, and this variant has none. ` +
        `Refusing to treat cost as zero: that would price the item at nothing.`,
    );
  }
  return baseline.cost;
}

/** Zero in the given currency, for callers that need an explicit floor. */
export function zeroIn(currency: string): Money {
  return money(0, currency);
}
