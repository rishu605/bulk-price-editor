/**
 * What a campaign does to margin.
 *
 * Almost every competitor treats a price change as data entry: you type a percentage,
 * prices move, and nobody tells you what it cost you. This is the answer to "what does
 * this sale actually do to my margins", computed before the sale runs.
 *
 * **This is arithmetic on price and cost, not attribution.** It says what the margin on
 * each product becomes; it does not say what you will sell or what you will earn. That
 * half needs order data and is a separate, approval-gated feature — and conflating the
 * two is how a merchant makes an expensive decision on bad inference.
 *
 * **Products with no cost are counted and named, never estimated.** A blended margin that
 * quietly assumed a cost for the 40% of a catalogue that has none would be a number that
 * looks precise and is invented. Saying "we can only tell you about 1,159 of your 1,616
 * products" is less satisfying and considerably more useful.
 */

import type { Money } from "../money/money";

export interface MarginInput {
  variantGid: string;
  title: string;
  /** Absent for a product with no cost recorded. */
  cost?: Money;
  before: Money;
  after: Money;
}

export interface MarginRow {
  variantGid: string;
  title: string;
  /** Percent of selling price, before the campaign. */
  before: number;
  after: number;
  /** Percentage points lost. Negative means the campaign improves margin. */
  delta: number;
}

export interface MarginImpact {
  /** Products the calculation could use. */
  covered: number;
  /** Products with no cost, so nothing can be said about them. */
  unknown: number;
  /** Mean margin across covered products, before and after. */
  averageBefore: number;
  averageAfter: number;
  /** Percentage points. Positive means margin falls. */
  averageDelta: number;
  /** Covered products whose margin after the campaign is below the target. */
  belowTarget: MarginRow[];
  /** Products that end up priced at or below cost. The ones that lose money per sale. */
  belowCost: MarginRow[];
}

/** Gross margin as a percentage of selling price. */
export function marginPercent(price: Money, cost: Money): number {
  if (price.amount === 0) return 0;
  return ((price.amount - cost.amount) / price.amount) * 100;
}

/**
 * The margin picture for a planned campaign.
 *
 * `targetPercent` is what the merchant considers acceptable — the store's minimum margin
 * guardrail where one is set. Products falling below it are listed rather than counted,
 * because "eleven products drop under 20%" prompts the question "which ones", and the
 * answer should already be on screen.
 */
export function marginImpact(
  rows: readonly MarginInput[],
  targetPercent: number | null,
): MarginImpact {
  const covered: MarginRow[] = [];
  let unknown = 0;

  for (const row of rows) {
    if (!row.cost) {
      unknown += 1;
      continue;
    }

    const before = marginPercent(row.before, row.cost);
    const after = marginPercent(row.after, row.cost);

    covered.push({
      variantGid: row.variantGid,
      title: row.title,
      before,
      after,
      delta: before - after,
    });
  }

  const averageBefore = mean(covered.map((row) => row.before));
  const averageAfter = mean(covered.map((row) => row.after));

  return {
    covered: covered.length,
    unknown,
    averageBefore,
    averageAfter,
    averageDelta: averageBefore - averageAfter,
    // Worst first. A merchant scanning this wants the products that moved most, not the
    // ones that happen to sort first alphabetically.
    belowTarget:
      targetPercent === null
        ? []
        : covered.filter((row) => row.after < targetPercent).sort((a, b) => a.after - b.after),
    belowCost: covered.filter((row) => row.after <= 0).sort((a, b) => a.after - b.after),
  };
}

/**
 * How to describe the impact, in a sentence a merchant can act on.
 *
 * Says "directional" where it is directional and says nothing where it knows nothing.
 * The coverage caveat comes first when coverage is poor, because a margin figure computed
 * from a third of a catalogue is a different claim from one computed from all of it, and
 * burying that below the headline number would be the misleading part.
 */
export function describeImpact(impact: MarginImpact, currencyTarget: number | null): string {
  if (impact.covered === 0) {
    return (
      "None of these products has a cost recorded, so nothing can be said about margin. " +
      "Import your costs and this will fill in."
    );
  }

  const coverage =
    impact.unknown > 0
      ? ` Based on the ${impact.covered} products that have a cost; ${impact.unknown} do not and are not included.`
      : "";

  const direction =
    impact.averageDelta > 0
      ? `drops about ${impact.averageDelta.toFixed(1)} points, from ${impact.averageBefore.toFixed(1)}% to ${impact.averageAfter.toFixed(1)}%`
      : `rises about ${Math.abs(impact.averageDelta).toFixed(1)} points, from ${impact.averageBefore.toFixed(1)}% to ${impact.averageAfter.toFixed(1)}%`;

  const warnings: string[] = [];
  if (impact.belowCost.length > 0) {
    warnings.push(
      `${impact.belowCost.length} would sell at or below cost.`,
    );
  }
  if (currencyTarget !== null && impact.belowTarget.length > 0) {
    warnings.push(
      `${impact.belowTarget.length} would fall below your ${currencyTarget}% target.`,
    );
  }

  return `Average margin ${direction}.${coverage}${warnings.length ? ` ${warnings.join(" ")}` : ""}`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
