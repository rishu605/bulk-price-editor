/**
 * Why the planner left a row alone, in the merchant's words.
 *
 * Two phrasings of one set of reasons: a run summary groups rows ("14 variants have no
 * cost recorded"), while a preview names one row at a time ("No cost recorded"). They
 * are kept in one file, over one key set, because the failure mode of keeping them apart
 * is that a reason gets added to the resolver and phrased in one place only — so the
 * other renders "unknown" for a case the app understands perfectly well.
 *
 * `reasons.test.ts` asserts both maps cover exactly the `ResolutionReason` union, so
 * adding a reason without phrasing it is a build-time failure rather than a word a
 * merchant cannot act on.
 */

import type { ResolutionReason } from "../pricing/types";

/** Plural, for a run summary that groups rows by reason. */
export const SKIP_REASON_GROUP: Record<ResolutionReason, string> = {
  "missing-cost": "have no cost recorded, and a cost-based guardrail applies",
  "missing-import": "were not in the imported file",
  "below-floor": "would have priced below a guardrail floor",
  "invalid-margin": "have a margin target that cannot be satisfied",
  "invalid-compare-at": "would have had a compare-at price below their price",
  "non-positive-price": "would have priced at or below zero",
};

/** Singular, for one row in a preview table. */
export const SKIP_REASON_ROW: Record<ResolutionReason, string> = {
  "missing-cost": "No cost recorded",
  "missing-import": "Not in the imported file",
  "below-floor": "Below your price floor",
  "invalid-margin": "Margin target cannot be met",
  "invalid-compare-at": "Compare-at would be below the price",
  "non-positive-price": "Would price at or below zero",
};

/** The row phrasing, tolerant of a reason the planner did not attach. */
export function skipReasonForRow(reason: string | undefined): string {
  return SKIP_REASON_ROW[reason as ResolutionReason] ?? "Not written";
}
