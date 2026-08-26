/**
 * Tiered wholesale pricing: buy more, pay less per unit.
 *
 * A B2B catalogue's price is not one number. It is a ladder — 1+ at £40, 12+ at £36,
 * 48+ at £32 — and the ladder is what a buyer agreed to. That makes the failure modes
 * different from retail:
 *
 * - **A ladder that goes the wrong way is nonsense, not a rounding error.** If 48+ costs
 *   more per unit than 12+, a buyer ordering more pays more, and no amount of "the
 *   percentage was applied correctly" makes that acceptable. It is refused, not clamped.
 *
 * - **The floor is cost plus a negotiated margin, not a retail margin.** Wholesale runs
 *   thinner deliberately, so the retail guardrail would refuse every legitimate tier
 *   while a wholesale floor of the same shape catches the ones that actually lose money.
 *
 * - **Breaching a contracted price is a commercial problem.** So a clamp here is reported
 *   per tier rather than folded into a single "some rows were clamped" count: the
 *   merchant has to be able to see *which tier* moved, because that is the one they may
 *   have promised somebody in writing.
 */

import { greaterThan, money, type Money } from "../money/money";
import { priceForMargin } from "./guardrails";

/** One rung of the ladder. */
export interface QuantityTier {
  /** Smallest order quantity this price applies to. */
  minimumQuantity: number;
  /** Basis points off the baseline. 2000 = 20% off. */
  discountBps: number;
}

export interface BreakInput {
  variantGid: string;
  /** The catalogue's own reference price, in the catalogue's currency. */
  baseline: Money;
  /** Absent for a variant with no cost recorded. */
  cost?: Money;
}

export interface ResolvedBreak {
  minimumQuantity: number;
  price: Money;
  /** Set when the wholesale floor moved this tier's price up. */
  clampedFrom?: Money;
}

export interface BreakResult {
  variantGid: string;
  breaks: ResolvedBreak[];
  /** Why nothing was produced. A refusal is never silent. */
  refusal?: string;
}

export interface WholesaleGuardrail {
  /** Minimum gross margin over cost, as a percentage of selling price. */
  minMarginPercent: number;
  /**
   * What to do about a variant with no cost.
   *
   * Wholesale defaults to refusing rather than pricing: on a retail surface an unknown
   * cost means an unenforced guardrail, which is a risk. Here it means pricing goods
   * whose margin nobody can compute against a contract, which is a different risk.
   */
  missingCost: "refuse" | "allow";
}

/** Basis points off an amount, on integers. `2000` takes 20% off. */
function lessBps(amount: Money, bps: number): Money {
  // Integer arithmetic throughout: a percentage of a price computed in floats is how a
  // ladder ends up a minor unit out at one rung and not another.
  const kept = 10_000 - bps;
  return money(Math.round((amount.amount * kept) / 10_000), amount.currency);
}

/**
 * The ladder for one variant, or a refusal explaining why there isn't one.
 *
 * Tiers are sorted by quantity before anything else, so a caller passing them out of
 * order gets the ladder they meant rather than a spurious refusal.
 */
export function resolveBreaks(
  input: BreakInput,
  tiers: readonly QuantityTier[],
  guardrail: WholesaleGuardrail,
): BreakResult {
  const refuse = (refusal: string): BreakResult => ({
    variantGid: input.variantGid,
    breaks: [],
    refusal,
  });

  if (tiers.length === 0) {
    return refuse(
      "This campaign has no quantity tiers, so there is nothing to write to the wholesale catalogue. Add at least one tier, such as 1+ at full price.",
    );
  }

  const sorted = [...tiers].sort((a, b) => a.minimumQuantity - b.minimumQuantity);

  for (const tier of sorted) {
    if (!Number.isInteger(tier.minimumQuantity) || tier.minimumQuantity < 1) {
      return refuse(
        `A tier starts at ${tier.minimumQuantity} units. A quantity break has to start at a whole number of units, one or more.`,
      );
    }
  }

  const duplicate = sorted.find(
    (tier, index) => index > 0 && tier.minimumQuantity === sorted[index - 1]!.minimumQuantity,
  );
  if (duplicate) {
    return refuse(
      `Two tiers both start at ${duplicate.minimumQuantity} units. Shopify keeps one of them and there is no way to say which.`,
    );
  }

  const floor =
    input.cost === undefined
      ? undefined
      : priceForMargin(input.cost, guardrail.minMarginPercent);

  if (input.cost === undefined && guardrail.missingCost === "refuse") {
    return refuse(
      "No cost is recorded for this product, so the wholesale floor cannot be checked. Import a cost, or allow pricing without one in settings.",
    );
  }

  const breaks: ResolvedBreak[] = [];

  for (const tier of sorted) {
    const wanted = lessBps(input.baseline, tier.discountBps);
    const clamped = floor && greaterThan(floor, wanted);

    breaks.push({
      minimumQuantity: tier.minimumQuantity,
      price: clamped ? floor : wanted,
      ...(clamped ? { clampedFrom: wanted } : {}),
    });
  }

  // Checked *after* clamping, because clamping is what breaks a ladder in practice: two
  // tiers that both hit the floor end up equal, and a lower tier hitting it while a
  // higher one does not inverts the ladder outright.
  const inversion = breaks.find(
    (tier, index) => index > 0 && greaterThan(tier.price, breaks[index - 1]!.price),
  );
  if (inversion) {
    return refuse(
      `Ordering ${inversion.minimumQuantity} or more would cost more per unit than ordering fewer. That happens when the wholesale floor lifts a larger tier above a smaller one; lower the floor or the discount on the smaller tier.`,
    );
  }

  return { variantGid: input.variantGid, breaks };
}
