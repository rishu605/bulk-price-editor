/**
 * Changing costs in bulk, by rule.
 *
 * The obvious use is a supplier price rise: every cost in one vendor goes up 4%. The less
 * obvious one is a merchant who has never recorded costs at all and knows their catalogue
 * runs at roughly a 60% margin — setting cost as a share of price gets the guardrails
 * doing something useful today, and they can refine it later.
 *
 * A cost is not a price and none of this writes to a storefront. What it changes is what
 * the app will *refuse* to do, which is why the interesting behaviour lives elsewhere:
 * see `cost-edit.server.ts` for what happens to a campaign that was legal before the
 * change and is not after it.
 */

import { decimalsFor, format } from "../money/format";
import { abs, money, type Money } from "../money/money";

export type CostRule =
  | { kind: "set-exact"; amount: Money }
  | { kind: "percent-change"; percent: number }
  | { kind: "fixed-change"; amount: Money }
  /** Cost as a share of the baseline price — for a catalogue with no costs at all. */
  | { kind: "share-of-price"; percent: number };

export interface CostRuleInput {
  /** The variant's current cost, if it has one. */
  cost?: Money;
  /** The variant's baseline price, for `share-of-price`. */
  basePrice: Money;
}

export type CostOutcome =
  | { kind: "set"; cost: Money }
  /** Nothing to compute from — reported rather than guessed at. */
  | { kind: "skipped"; reason: "no-cost" | "not-positive" };

/**
 * The new cost for one variant.
 *
 * A rule that needs an existing cost skips a variant that has none rather than treating
 * it as zero. Zero is a real cost — a free sample — and inventing it here would set a
 * floor of nothing on every product the merchant simply had not filled in, which turns
 * the guardrail off precisely where it was most needed.
 */
export function applyCostRule(rule: CostRule, input: CostRuleInput): CostOutcome {
  const currency = input.basePrice.currency;

  switch (rule.kind) {
    case "set-exact":
      return positive(rule.amount);

    case "share-of-price":
      return positive(money(Math.round((input.basePrice.amount * rule.percent) / 100), currency));

    case "percent-change": {
      if (!input.cost) return { kind: "skipped", reason: "no-cost" };
      return positive(
        money(Math.round(input.cost.amount * (1 + rule.percent / 100)), currency),
      );
    }

    case "fixed-change": {
      if (!input.cost) return { kind: "skipped", reason: "no-cost" };
      return positive(money(input.cost.amount + rule.amount.amount, currency));
    }
  }
}

/**
 * A cost must not be negative.
 *
 * Zero is allowed — a giveaway genuinely costs nothing — but a negative cost would make
 * `priceForMargin` produce a negative floor, which silently disables the guardrail rather
 * than tightening it.
 */
function positive(cost: Money): CostOutcome {
  return cost.amount < 0 ? { kind: "skipped", reason: "not-positive" } : { kind: "set", cost };
}

/**
 * The rule the merchant typed on the cost form, in the store's currency.
 *
 * `10 ** decimalsFor(currency)`, as `ruleFrom` does for campaigns since #343, and not a
 * literal 100: that stored a ¥1,500 cost as ¥150,000 and a 1.5 KWD cost as 0.150 (#694).
 * Costs set the never-below-cost floor, so the yen mistake priced a ¥3,000 product at
 * ¥150,000 on the next run, and the dinar one took the floor away.
 */
export function costRuleFrom(kind: string, value: number, currency: string): CostRule {
  const perMajor = 10 ** decimalsFor(currency);
  switch (kind) {
    case "set-exact":
      return { kind: "set-exact", amount: money(Math.round(value * perMajor), currency) };
    case "fixed-change":
      return { kind: "fixed-change", amount: money(Math.round(value * perMajor), currency) };
    case "share-of-price":
      return { kind: "share-of-price", percent: value };
    default:
      return { kind: "percent-change", percent: value };
  }
}

/**
 * What the rule does, for the confirmation screen.
 *
 * Through the money formatter, so the text shows what will be stored. It used to divide by
 * a literal 100 as well, which cancelled the form's mistake: the dry run read "1500.00"
 * while ¥150,000 was written.
 */
export function describeCostRule(rule: CostRule): string {
  switch (rule.kind) {
    case "set-exact":
      return `Set every matching cost to ${format(rule.amount)}`;
    case "percent-change":
      return rule.percent >= 0
        ? `Raise every matching cost by ${rule.percent}%`
        : `Lower every matching cost by ${Math.abs(rule.percent)}%`;
    case "fixed-change":
      return rule.amount.amount >= 0
        ? `Add ${format(rule.amount)} to every matching cost`
        : `Subtract ${format(abs(rule.amount))} from every matching cost`;
    case "share-of-price":
      return `Set every matching cost to ${rule.percent}% of its normal price`;
  }
}
