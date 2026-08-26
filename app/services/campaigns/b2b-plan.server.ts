/**
 * Turning a campaign's quantity tiers into ladders for one wholesale catalogue.
 *
 * The step between "the merchant configured 1+/12+/48+" and "these are the rungs to
 * write". It is separate from the executor because the interesting decisions are all
 * here: which variants can be priced at all, which refuse, and what the merchant is told
 * about the ones that do.
 *
 * **Refusals are per variant and never silent.** A ladder that inverts, or a product with
 * no cost, takes that product out of this run — and the campaign says which and why. A
 * wholesale price is usually something a buyer was quoted, so "some products were skipped"
 * is not an acceptable summary.
 */

import {
  resolveBreaks,
  type QuantityTier,
  type WholesaleGuardrail,
} from "../../lib/pricing/quantity-breaks";
import type { QuantityRow } from "../../lib/execution/quantity-executor";
import type { Money } from "../../lib/money/money";

export interface B2BVariantInput {
  variantGid: string;
  title: string;
  /** The catalogue's reference price for this variant, in the catalogue's currency. */
  baseline: Money;
  cost?: Money;
}

export interface B2BPlan {
  rows: QuantityRow[];
  /** Variants deliberately not priced, with the reason a merchant can act on. */
  refused: Array<{ variantGid: string; title: string; reason: string }>;
  /** Tiers the wholesale floor moved, worst first. Written, but worth seeing. */
  clamped: Array<{ variantGid: string; title: string; minimumQuantity: number; from: Money; to: Money }>;
  messages: string[];
}

/**
 * The ladders for one catalogue.
 *
 * `tiers` being absent is not the same as being empty: absent means this campaign is not
 * a tiered one and there is nothing to do here, while empty means somebody configured a
 * ladder with no rungs, which is a mistake worth reporting.
 */
export function planQuantityBreaks(
  variants: readonly B2BVariantInput[],
  tiers: QuantityTier[] | undefined,
  guardrail: WholesaleGuardrail,
): B2BPlan {
  const plan: B2BPlan = { rows: [], refused: [], clamped: [], messages: [] };

  if (tiers === undefined) return plan;

  for (const variant of variants) {
    const result = resolveBreaks(
      { variantGid: variant.variantGid, baseline: variant.baseline, cost: variant.cost },
      tiers,
      guardrail,
    );

    if (result.refusal) {
      plan.refused.push({
        variantGid: variant.variantGid,
        title: variant.title,
        reason: result.refusal,
      });
      continue;
    }

    plan.rows.push({
      variantGid: variant.variantGid,
      breaks: result.breaks.map((tier) => ({
        minimumQuantity: tier.minimumQuantity,
        price: tier.price,
      })),
    });

    for (const tier of result.breaks) {
      if (!tier.clampedFrom) continue;
      plan.clamped.push({
        variantGid: variant.variantGid,
        title: variant.title,
        minimumQuantity: tier.minimumQuantity,
        from: tier.clampedFrom,
        to: tier.price,
      });
    }
  }

  plan.messages = describe(plan, variants.length);
  return plan;
}

/**
 * What the campaign says about this catalogue.
 *
 * Bad news first, and refusals grouped by reason rather than listed per product: forty
 * products refused for the same missing-cost reason is one thing to fix, and forty lines
 * saying so is a wall nobody reads.
 */
function describe(plan: B2BPlan, total: number): string[] {
  const messages: string[] = [];

  if (plan.refused.length > 0) {
    const byReason = new Map<string, number>();
    for (const entry of plan.refused) {
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    }

    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      messages.push(
        `${count} of ${total} product${total === 1 ? "" : "s"} will not be given quantity breaks. ${reason}`,
      );
    }
  }

  if (plan.clamped.length > 0) {
    const variants = new Set(plan.clamped.map((entry) => entry.variantGid)).size;
    messages.push(
      `Your wholesale floor raised ${plan.clamped.length} price break${plan.clamped.length === 1 ? "" : "s"} across ${variants} product${variants === 1 ? "" : "s"}. Those tiers will not be the price you asked for — check any you have quoted to a buyer.`,
    );
  }

  return messages;
}
