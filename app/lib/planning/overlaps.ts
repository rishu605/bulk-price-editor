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
import type { PlanCoverage, PlanUnchanged } from "./types";

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

/**
 * The variants a plan found already at their price (`counts.noop`), by who prices them (#837).
 *
 * "Already correct" only means the live price equals the resolved one, and the resolved one
 * can be another campaign's. The Apply dialog called every one of them "still owned by this
 * campaign", so a sale applied under a higher-priority one was told it owned the variants the
 * other one was pricing. Split by the resolver's own winner, never by comparing prices here.
 */
export interface AlreadyCorrect {
  /** At this campaign's own price: the resolver gives it the variant. */
  own: number;
  /** At their normal price: no campaign prices them -- excluded, or no rule row matches. */
  unpriced: number;
  /** At another campaign's price, which outranks this one: by campaign, biggest first. */
  others: Array<{ campaignId: string; name: string; status: string; variants: number }>;
}

export function alreadyCorrectBy(
  unchanged: readonly PlanUnchanged[],
  plannedId: string,
  others: ReadonlyArray<{ id: string; name: string; status: string }>,
): AlreadyCorrect {
  const byId = new Map(others.map((other) => [other.id, other]));
  const kept = new Map<string, number>();
  let own = 0;
  let unpriced = 0;
  for (const { campaignId } of unchanged) {
    if (campaignId === plannedId) own++;
    else if (!campaignId) unpriced++;
    else kept.set(campaignId, (kept.get(campaignId) ?? 0) + 1);
  }
  return {
    own,
    unpriced,
    others: [...kept]
      .map(([campaignId, variants]) => ({
        campaignId,
        name: byId.get(campaignId)?.name ?? "Another campaign",
        status: byId.get(campaignId)?.status ?? "ACTIVE",
        variants,
      }))
      .sort((a, b) => b.variants - a.variants || a.name.localeCompare(b.name)),
  };
}

/**
 * The Apply dialog's lines for the variants already at their price: each kind under its own
 * label, and another campaign's by name (#837). Without the split -- a preview made before it
 * existed -- a count, claiming no owner.
 */
export function alreadyCorrectFacts(
  noop: number,
  already: AlreadyCorrect | undefined,
): Array<{ label: string; text: string }> {
  const count = (n: number) => `${formatCount(n)} ${n === 1 ? "variant" : "variants"}`;
  if (!already) return noop > 0 ? [{ label: "Already correct", text: `${formatCount(noop)} — no write needed` }] : [];
  return [
    ...(already.own > 0
      ? [{ label: "Already correct", text: `${count(already.own)} already at this campaign's price — no write needed` }]
      : []),
    ...(already.others.length > 0
      ? [
          {
            label: "Priced by another campaign",
            text: already.others
              .map(
                (other) =>
                  `${count(other.variants)} priced by ${other.name}${stateNote(other.status)} until it ends, so nothing is written for ${other.variants === 1 ? "it" : "them"}.`,
              )
              .join(" "),
          },
        ]
      : []),
    ...(already.unpriced > 0
      ? [{ label: "At normal price", text: `${count(already.unpriced)} this campaign does not price — no write needed` }]
      : []),
  ];
}

/**
 * The campaigns pricing every variant this one covers, when it prices none of them itself
 * (#837) -- the case where "your storefront shows the campaign price" is false. Empty when
 * it prices any, covers none, or any of what it covers is priced by nobody: no sentence
 * about who outranks it would then be true of all of them.
 */
export function outrankedBy(
  coverage: readonly PlanCoverage[],
  plannedId: string,
  others: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const own = coverage.find((entry) => entry.campaignId === plannedId);
  if (!own || own.covers === 0 || own.wins > 0) return [];
  const yielded = Object.values(own.yieldsTo).reduce((sum, n) => sum + n, 0);
  if (yielded < own.covers) return [];
  const byId = new Map(others.map((other) => [other.id, other.name]));
  return Object.entries(own.yieldsTo)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([campaignId]) => byId.get(campaignId) ?? "Another campaign");
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
