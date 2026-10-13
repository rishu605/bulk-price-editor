/**
 * Which other campaigns share a campaign's variants, and who prices them (#821).
 *
 * The thing no competitor can say. All three compute against the live price and none of
 * them resolves overlap: RUBIX puts a warning in its editor telling merchants not to
 * create a second task over the same products, and its FAQ explains with worked numbers
 * that reverting out of order leaves a product wrong for ever. NA and Sami do the same
 * thing and say nothing at all.
 *
 * We resolve it, by priority, and a revert recomputes rather than restoring -- so the
 * honest thing is not a warning but a statement of what will happen. Read from the
 * planner's coverage, the resolver's own answer for every variant in scope, rather than
 * recomputed from priorities here: a second implementation would be free to disagree.
 */

import { formatCount } from "../format/display";
import type { PlanCoverage } from "./types";

export interface Overlap {
  campaignId: string;
  name: string;
  priority: number;
  /** Its state, so a held or partial campaign reads as one. */
  status: string;
  /** Variants in this campaign's scope the other one keeps: it outranks this one, or a hand edit holds them. */
  keeps: number;
  /** Variants the other one covers that this campaign prices instead: it is outranked. */
  yields: number;
}

/**
 * The overlaps of the campaign `plannedId` -- the draft or campaign being planned, or the
 * one being reverted, which then yields nothing because it is out of the plan.
 *
 * Biggest first, because a merchant reading this wants the one that matters first, and a
 * campaign sharing four variants of three thousand is a footnote.
 */
export function overlapsFrom(
  coverage: readonly PlanCoverage[],
  plannedId: string,
  others: ReadonlyArray<{ id: string; name: string; priority: number; status: string }>,
): Overlap[] {
  const byId = new Map(others.map((other) => [other.id, other]));
  return coverage
    .filter((entry) => entry.campaignId !== plannedId)
    .map((entry) => {
      const other = byId.get(entry.campaignId);
      return {
        campaignId: entry.campaignId,
        name: other?.name ?? "Another campaign",
        priority: other?.priority ?? 0,
        status: other?.status ?? "ACTIVE",
        keeps: entry.wins,
        yields: entry.yieldsTo[plannedId] ?? 0,
      };
    })
    .filter((overlap) => overlap.keeps + overlap.yields > 0)
    .sort((a, b) => b.keeps + b.yields - (a.keeps + a.yields) || a.name.localeCompare(b.name));
}

/** A campaign's state, said where it changes the reading: a held one still keeps its prices. */
export function stateNote(status: string): string {
  switch (status) {
    case "HELD":
      return " (held for a hand edit)";
    case "PARTIAL":
      return " (partly applied)";
    case "APPLYING":
      return " (being applied)";
    default:
      return "";
  }
}

/**
 * The overlaps as short sentences, for a place that has no room for the panel -- the Apply
 * dialog, where the merchant decides (#821).
 */
export function overlapSentences(overlaps: readonly Overlap[]): string[] {
  const count = (n: number) => `${formatCount(n)} ${n === 1 ? "variant" : "variants"}`;
  return overlaps.flatMap((overlap) => [
    ...(overlap.keeps > 0
      ? [`${overlap.name}${stateNote(overlap.status)} keeps ${count(overlap.keeps)}; it outranks this campaign.`]
      : []),
    ...(overlap.yields > 0
      ? [`This campaign takes ${count(overlap.yields)} from ${overlap.name}${stateNote(overlap.status)}; reverting it hands them back.`]
      : []),
  ]);
}
