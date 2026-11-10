/**
 * What a campaign does when the compare-at it would write is not above the new price (#817,
 * PRD A-3.3, E11).
 *
 * A strike-through at or under the price shows no saving, or an apparent rise, so the resolver
 * never writes one. What it does instead was `"clear"` for every campaign: `createCampaign`
 * and `toResolvable` both wrote it, and the editor offered nothing. It is the campaign's choice
 * now, defaulting to what every campaign did. The labels are here so the editor's select, the
 * campaign page and the sentence a blocked plan reads say one thing.
 */

import type { CompareAtViolationPolicy } from "../pricing/types";

/** In the order the select offers them: today's behaviour first. */
export const COMPARE_AT_VIOLATIONS = ["clear", "skip", "block"] as const satisfies readonly CompareAtViolationPolicy[];

export const COMPARE_AT_VIOLATION_LABELS: Record<CompareAtViolationPolicy, string> = {
  clear: "Drop the strike-through",
  skip: "Leave the variant at its price",
  block: "Stop the campaign",
};

/** What the select is called, and what the campaign page says it beside. */
export const COMPARE_AT_VIOLATION_QUESTION = "If the compare-at would not be above the new price";

/**
 * A stored policy, made safe: the column is a plain string defaulting to "clear", so anything
 * else -- an older row, a value from a release rolled back -- reads as "clear", the one every
 * campaign had before the choice existed and the one that keeps a price written.
 */
export function asCompareAtViolation(stored: unknown): CompareAtViolationPolicy {
  return stored === "skip" || stored === "block" ? stored : "clear";
}
