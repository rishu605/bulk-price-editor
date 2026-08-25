/**
 * Domain types for price resolution.
 *
 * Everything the resolver needs is passed in. It reads no database, no clock and no
 * environment — which is what makes it property-testable and what makes a preview
 * trustworthy. In particular, note what is *absent*: the variant's current live
 * price. The resolver cannot see it, so it structurally cannot compute a discount
 * relative to an already-discounted price. That is the compounding bug this whole
 * product exists to prevent, eliminated by the type signature rather than by care.
 */

import type { Money } from "../money/money";
import type { RoundingPolicy } from "../money/rounding-policy";

/** Which price surface a resolution targets. */
export type SurfaceKind = "base" | "market" | "b2b";

export interface Surface {
  kind: SurfaceKind;
  /** Price list gid for market/b2b surfaces; absent for base. */
  priceListId?: string;
  currency: string;
}

/**
 * The durable reference price. Campaign maths reads this, never the live price.
 */
export interface Baseline {
  price: Money;
  compareAtPrice?: Money;
  /** Cost per item. Frequently absent on real catalogues — never assume zero. */
  cost?: Money;
}

// ------------------------------------------------------------------- rules

export type AdjustmentRule =
  /** Percentage change from the baseline price. -20 reduces by 20%. */
  | { kind: "percent-change"; percent: number }
  /** Fixed change from the baseline price, in the surface currency. */
  | { kind: "fixed-change"; amount: Money }
  /** Ignore the baseline; set this exact price. */
  | { kind: "set-exact"; amount: Money }
  /** cost × factor. 2.5 is a 2.5x markup. */
  | { kind: "from-cost-multiplier"; factor: number }
  /**
   * Price giving this gross margin on cost: price = cost / (1 - margin/100).
   * Margin is a percentage of the *selling price*, the usual retail convention.
   */
  | { kind: "from-cost-margin"; marginPercent: number }
  /** Percentage change from the baseline compare-at price. */
  | { kind: "percent-of-compare-at"; percent: number };

/**
 * A rule scoped to a subset of a campaign's variants.
 *
 * A campaign may carry several ("-20% on Collection A, -30% on Collection B").
 * Where a variant matches more than one, the *last* matching row wins — a total,
 * deterministic order rather than an error, so the outcome is always predictable
 * (edge case E16). The UI surfaces overlaps in the preview.
 */
export interface RuleRow {
  /** Segment ids this row applies to. Empty means the whole campaign scope. */
  segmentIds: string[];
  rule: AdjustmentRule;
}

// --------------------------------------------------------------- compare-at

export type CompareAtPolicy =
  /** Copy the baseline price into compare-at, producing a strike-through sale. */
  | { kind: "set-to-baseline" }
  /** Derive compare-at from the baseline compare-at by rule. */
  | { kind: "adjust"; rule: AdjustmentRule }
  /** Remove any compare-at. */
  | { kind: "clear" }
  /** Do not write compare-at at all. */
  | { kind: "leave" };

/** What to do when the computed compare-at would not exceed the final price. */
export type CompareAtViolationPolicy = "skip" | "clear" | "block";

// --------------------------------------------------------------- guardrails

/**
 * Floors below which a price must never be written.
 *
 * Campaign-level guardrails may only *tighten* store-level ones; the merge helper
 * enforces that. A campaign able to relax a store-wide "never below cost" rule would
 * make the store setting meaningless.
 */
export interface Guardrails {
  /** Never price at or below cost. Requires cost to be present. */
  neverBelowCost?: boolean;
  /** Minimum gross margin as a percentage of selling price. */
  minMarginPercent?: number;
  /** Absolute minimum price. */
  minPrice?: Money;
  /**
   * What to do when a variant has no cost but a cost-dependent guardrail applies.
   * "skip" excludes the variant; "error" fails the run. Never silently treat cost
   * as zero — that would let a campaign price below cost while reporting success.
   */
  missingCostPolicy?: "skip" | "error";
}

/** What happens when a computed price violates a floor. */
export type GuardrailViolationPolicy = "clamp" | "skip" | "block";

// ---------------------------------------------------------------- campaigns

/**
 * A campaign as the resolver sees it: already known to be active and to target this
 * surface, with this variant already known to be enrolled. Filtering by status and
 * enrollment happens in the planner, where the clock and the database live.
 */
export interface ResolvableCampaign {
  id: string;
  /** Higher wins. Defaults to 100 in the UI. */
  priority: number;
  /** Tie-break for equal priority: later start wins. Epoch milliseconds. */
  startAt: number;
  ruleRows: RuleRow[];
  compareAtPolicy: CompareAtPolicy;
  compareAtViolationPolicy: CompareAtViolationPolicy;
  /**
   * Rounding, per currency.
   *
   * A policy rather than a profile because a campaign that prices into three markets
   * prices in three currencies, and the charm ending that reads as considered in one
   * reads as broken in another. Yen has no sub-unit for one at all (E9).
   */
  roundingPolicy: RoundingPolicy;
  /** Tightens the store guardrails for this campaign only. */
  guardrails?: Guardrails;
  guardrailViolationPolicy: GuardrailViolationPolicy;
  /**
   * Variants this campaign no longer prices, because someone reverted them out of it
   * individually.
   *
   * Not a filter applied before resolution -- an input to it. Removing the campaign
   * for one variant lets the next campaign in priority order take over, which is the
   * whole point: a variant pulled out of a 30% sale that also sits in a 10% one
   * should land on 10%, not on full price. Filtering the candidate out upstream would
   * silently produce the latter.
   *
   * The resolver itself never sees this, because it has no variant identity by
   * design. The planner applies it per candidate, in the same place it applies a
   * campaign-level revert, so preview and execution cannot disagree.
   */
  excludedVariantGids?: string[];
}

// ------------------------------------------------------------------ results

export type ResolutionOutcome =
  /** A price was computed and should be written. */
  | "priced"
  /** No campaign controls this variant; it sits at baseline. */
  | "baseline"
  /** Excluded by a guardrail or compare-at policy. Nothing is written. */
  | "skipped"
  /** A policy set to "block" was violated. The run must not proceed. */
  | "blocked";

export interface ResolutionMeta {
  outcome: ResolutionOutcome;
  /** Campaign id controlling this variant, if any. */
  controlledBy?: string;
  /** The rule that produced the price, for preview attribution. */
  appliedRule?: AdjustmentRule;
  /** True when a guardrail floor raised the computed price. */
  clamped: boolean;
  /** The floor that applied, when one was computed. */
  floor?: Money;
  /** Machine-readable reason for a skip or block. */
  reason?: ResolutionReason;
  /** The price before rounding, for explaining preview output. */
  unroundedPrice?: Money;
}

export type ResolutionReason =
  | "below-floor"
  | "missing-cost"
  | "invalid-compare-at"
  | "invalid-margin"
  | "non-positive-price";

export interface Resolution {
  /** The price to write. Absent when nothing should be written. */
  price?: Money;
  /**
   * The compare-at to write. `null` means explicitly clear it; `undefined` means
   * leave whatever is there. The distinction is load-bearing — conflating them
   * either wipes a merchant's compare-at or fails to set up a strike-through.
   */
  compareAtPrice?: Money | null;
  meta: ResolutionMeta;
}

export interface ResolveInput {
  baseline: Baseline;
  surface: Surface;
  /** Campaigns already filtered to active + targeting this surface + enrolled. */
  campaigns: ResolvableCampaign[];
  /** Store-level guardrails. Campaign guardrails may only tighten these. */
  storeGuardrails?: Guardrails;
  /** Segment ids this variant belongs to, for matching rule rows. */
  variantSegmentIds?: string[];
}
