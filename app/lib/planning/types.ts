/**
 * Planning types.
 *
 * The planner turns a campaign into concrete ledger rows. Its core is kept pure —
 * it takes already-fetched inputs and returns rows to write, doing no I/O itself —
 * so the diffing and policy logic is property-testable without a database. The
 * streaming and persistence layer sits around it.
 */

import type { Money } from "../money/money";
import type {
  Baseline,
  Guardrails,
  ResolvableCampaign,
  ResolutionReason,
  SurfaceKind,
} from "../pricing/types";

/** Identifies one writable cell: a variant on a surface. */
export interface SurfaceRef {
  variantGid: string;
  surfaceKind: SurfaceKind;
  /** Empty string for the base surface, matching the schema's non-null column. */
  priceListGid: string;
  currency: string;
}

/** A variant's current mirrored state on one surface, plus its baseline. */
export interface PlanCandidate {
  ref: SurfaceRef;
  baseline: Baseline;
  /** Live values from the mirror. Absent means we have no record of a live value. */
  livePrice?: Money;
  liveCompareAt?: Money;
  /** Segments this variant belongs to, for matching campaign rule rows. */
  segmentIds?: string[];
  /**
   * This variant's price in each import that names it, keyed by import id.
   *
   * Loaded by the caller, because the planner and resolver do no I/O — the same reason
   * baselines and live prices are passed in. A `from-import` rule with nothing here
   * prices nothing, which is correct for a variant the file did not mention.
   */
  importedPrices?: Record<string, Money>;
}

export type PlannedRowStatus = "pending" | "skipped" | "clamped";

/**
 * A row destined for `variant_changes`.
 *
 * `intendedCompareAtSet` mirrors the schema's boolean: a null `intendedCompareAt`
 * with the flag set means "clear it", and the flag unset means "leave it alone".
 * A nullable column alone cannot carry both instructions.
 */
export interface PlannedRow {
  ref: SurfaceRef;

  beforePrice?: Money;
  beforeCompareAt?: Money;

  intendedPrice?: Money;
  intendedCompareAt?: Money | null;
  intendedCompareAtSet: boolean;

  status: PlannedRowStatus;
  /** Set for skipped and clamped rows so the merchant gets a named reason. */
  reason?: ResolutionReason;
  /** Campaign that produced this row. */
  campaignId?: string;
}

export interface PlanCounts {
  /** Rows that will be written. */
  planned: number;
  /** Already at the intended value; nothing to do. */
  noop: number;
  /** Excluded by policy, with reasons. */
  skipped: number;
  /** Written, but raised: to a guardrail floor, or to the smallest price. */
  clamped: number;
  /**
   * Of `clamped`, rows raised to the smallest price because the rule reached zero or below
   * (E10). Not a guardrail, and never described as one: a store with none set was told
   * thirteen prices "would price below a guardrail" (#792).
   */
  clampedToMinimum: number;
}

/**
 * One campaign's share of a plan's variants: how many its scope covers, and how many of
 * those the resolver gives it (#821).
 *
 * Counted over every candidate, the already-correct ones included. Overlap used to be read
 * off the planned rows, and the rows leave out a variant already at its price -- which is
 * exactly the variant another campaign is keeping. So a sale entirely under a
 * higher-priority one found no overlap at all, and its revert dialog said nothing else
 * covered its variants.
 */
export interface PlanCoverage {
  campaignId: string;
  /** Base-price variants in this plan inside the campaign's own scope. */
  covers: number;
  /** Of those, the ones it prices: the resolver's winner, or the holder of a hand edit. */
  wins: number;
  /** Of the ones it covers and does not price, how many each other campaign prices instead. */
  yieldsTo: Record<string, number>;
}

export type PlanOutcome =
  | { kind: "ok"; rows: PlannedRow[]; counts: PlanCounts; coverage: PlanCoverage[] }
  /**
   * A "block" policy was violated. No rows are returned and nothing may be written —
   * a blocking guardrail must stop the entire run, not merely the offending variant.
   */
  | { kind: "blocked"; reason: ResolutionReason; ref: SurfaceRef; counts: PlanCounts };

export interface PlanInput {
  campaigns: ResolvableCampaign[];
  candidates: PlanCandidate[];
  storeGuardrails?: Guardrails;
  /**
   * The campaign being reverted, if this is a revert plan. Excluded from resolution
   * so the result is `resolve(without C)` — invariant I3.
   */
  excludeCampaignId?: string;
  /**
   * Variants a hand edit holds in another campaign, by the campaign holding them (#821).
   * Planned as skipped, whoever would win them: the merchant has been asked whether to
   * keep that price, and no other campaign's run writes it until they answer.
   */
  heldEdits?: ReadonlyMap<string, string>;
}

export type WritePath = "sync" | "bulk";

export interface WritePathDecision {
  path: WritePath;
  rowCount: number;
  reason: string;
}
