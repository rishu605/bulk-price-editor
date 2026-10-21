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
import type { LadderRung } from "../../lib/pricing/ladder-baseline";
import { selectWinner } from "../../lib/pricing/resolver";
import type { ResolvableCampaign } from "../../lib/pricing/types";

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
 * A campaign that prices a wholesale catalogue's ladders: one with quantity tiers whose
 * surfaces name the catalogue's price list. Ranked, scoped and excluded as the resolver
 * ranks, scopes and excludes every campaign. `scope` means what it means there: absent is
 * every variant, so a caller sets it for any campaign but the one being planned (#752).
 */
export interface TieredCampaign extends ResolvableCampaign {
  name: string;
  tiers: QuantityTier[];
}

/** A variant's reference on the catalogue: its price, and the ladder it had, if any. */
export interface LadderBaselineInput extends B2BVariantInput {
  /** The merchant's own ladder, from the baseline. Null: they had none. */
  ladder: LadderRung[] | null;
}

/**
 * Which tiered campaign prices this variant's ladder: the highest-ranked one whose scope
 * covers it and that has not let it go (`excludedVariantGids`), by the resolver's own order.
 *
 * Only tiered campaigns compete. A campaign with a single price does not write a ladder
 * when it applies, so it does not own one when another ends: what is on the catalogue after
 * a revert is what applying the campaigns that remain would leave there.
 */
export function ladderOwner(variantGid: string, campaigns: readonly TieredCampaign[]): TieredCampaign | undefined {
  const covering = campaigns.filter(
    (campaign) => (!campaign.scope || campaign.scope.has(variantGid)) && !campaign.excludedVariantGids?.includes(variantGid),
  );
  return selectWinner(covering) as TieredCampaign | undefined;
}

export interface LadderRevertPlan {
  rows: QuantityRow[];
  /** Variant gid to the campaign whose ladder it now gets. */
  handedTo: Map<string, string>;
  messages: string[];
}

/**
 * The ladders `resolve(without C)` gives these variants (rule 6, #704).
 *
 * `others` is every tiered campaign on the catalogue but the one ending. A variant one of
 * them prices gets that campaign's ladder, computed from its own baseline price; one nobody
 * prices gets the ladder the merchant had, or none. A ladder the next campaign refuses -- no
 * cost recorded, a tier that inverts -- is not left as the ending campaign's: the variant
 * goes back to its own, and the message says which campaign could not take it and why.
 */
export function planLadderRevert(
  variants: readonly LadderBaselineInput[],
  others: readonly TieredCampaign[],
  guardrail: WholesaleGuardrail,
): LadderRevertPlan {
  const plan: LadderRevertPlan = { rows: [], handedTo: new Map(), messages: [] };
  const refused = new Map<string, { campaign: string; reason: string; count: number }>();

  for (const variant of variants) {
    const owner = ladderOwner(variant.variantGid, others);
    const resolved = owner
      ? resolveBreaks({ variantGid: variant.variantGid, baseline: variant.baseline, cost: variant.cost }, owner.tiers, guardrail)
      : null;

    if (owner && resolved && !resolved.refusal) {
      plan.rows.push({
        variantGid: variant.variantGid,
        breaks: resolved.breaks.map((tier) => ({ minimumQuantity: tier.minimumQuantity, price: tier.price })),
      });
      plan.handedTo.set(variant.variantGid, owner.id);
      continue;
    }

    if (owner && resolved?.refusal) {
      const key = `${owner.id}|${resolved.refusal}`;
      const entry = refused.get(key) ?? { campaign: owner.name, reason: resolved.refusal, count: 0 };
      entry.count += 1;
      refused.set(key, entry);
    }
    plan.rows.push({ variantGid: variant.variantGid, breaks: variant.ladder ?? [] });
  }

  for (const { campaign, reason, count } of refused.values()) {
    plan.messages.push(
      `${count} product${count === 1 ? "" : "s"} could not take "${campaign}"'s quantity breaks, so ${count === 1 ? "it has" : "they have"} the ones from before any campaign. ${reason}`,
    );
  }
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
