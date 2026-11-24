/**
 * What a merchant reads when a blocking guardrail stops a campaign (#1076).
 *
 * It said "Blocked by a guardrail on gid://shopify/ProductVariant/46172975726826:
 * below-floor": no variant anyone could find, the cause as a code, no next step, and only
 * the first of the variants that blocked it -- fix that one and the next one blocked. Now
 * each blocking variant by name, the price it would get and the floor it breaches, and what
 * to do. One sentence for the preview, the editor, the run and Flow, so they cannot
 * disagree.
 */

import { BREACH_POLICY_LABELS, type BreachPolicy } from "../campaigns/breach-policy";
import { formatPrice } from "../money/format";
import type { Money } from "../money/money";
import { SKIP_REASON_ROW } from "./reasons";
import type { ResolutionReason } from "../pricing/types";

export interface BlockedLine {
  /** The variant as the merchant knows it. */
  title: string;
  reason: string;
  wouldBe?: Money;
  floor?: Money;
  /**
   * The running campaign whose policy stopped it, when that is not the campaign planned
   * (#1169): the one a revert hands the variant to, or one that outranks a draft on it. By
   * name, with the policy it runs with as `breachPolicyFor` reads it.
   */
  by?: { name: string; breach: BreachPolicy };
}

/** How many variants are named before "and N more". */
export const BLOCKED_NAMED = 5;

function line(entry: BlockedLine): string {
  const { title, reason, wouldBe, floor } = entry;
  // With its currency, as every price a merchant reads is (#759): "$0.33", not "0.33".
  const price = (value: Money) => formatPrice(value.amount, value.currency);
  // Whose price it is, where what to do names that campaign (#1169).
  const keeper = keeperOf(entry);
  const whose = keeper ? ` in "${keeper.name}"` : "";
  if (wouldBe && floor) return `"${title}" would be ${price(wouldBe)}${whose}, under its ${price(floor)} floor`;
  const phrase = SKIP_REASON_ROW[reason as ResolutionReason];
  return `"${title}"${whose}: ${phrase ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : "it breaches a guardrail"}`;
}

/**
 * The sentence. `when` is "preview" for a plan nothing has run yet -- the campaign page and the
 * editor -- and "run" for a run it stopped, which the history, the scheduler and Flow read.
 * `breach` is the planned campaign's floor-breach policy as `breachPolicyFor` reads it, which
 * decides what it is told to do (#1161); none where the store's setting decides it. `ownFloors`
 * says the planned campaign sets floors of its own (#816), so the floor to lower may be its own.
 */
export function blockedMessage(
  lines: readonly BlockedLine[],
  when: "preview" | "run",
  breach?: BreachPolicy,
  ownFloors = false,
): string {
  const named = lines.slice(0, BLOCKED_NAMED).map(line);
  const rest = lines.length - named.length;
  const list = named.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
  const opening =
    when === "run"
      ? "A guardrail stopped this run before anything was written"
      : "A guardrail set to block the whole campaign would stop it before anything is written";
  return `${opening}: ${list}. ${nextSteps(lines, breach, ownFloors ? "in Settings or in this campaign's own floors" : "in Settings")}`;
}

/** Whether a campaign keeps Block from its start, which the store's setting does not reach (D21). */
function keepsBlock(breach?: BreachPolicy): breach is BreachPolicy {
  return breach?.kept === true && breach.policy === "block";
}

/**
 * The other campaign that stopped this variant, when it keeps Block (#1169). Neither the setting
 * nor anything done to the campaign planned reaches it, so it is named, and what does reach it
 * is said. One that keeps Clamp or Skip was stopped by something else, a cost it needs, and the
 * variant is told what it always was.
 */
function keeperOf(entry: BlockedLine): BlockedLine["by"] {
  return entry.by && keepsBlock(entry.by.breach) ? entry.by : undefined;
}

/**
 * What to do: for the variants the planned campaign stopped, then for those another running
 * campaign's kept Block stopped (#1169), each by what reaches the campaign that stopped it.
 */
function nextSteps(lines: readonly BlockedLine[], breach: BreachPolicy | undefined, floorsAt: string): string {
  const own = lines.filter((entry) => !keeperOf(entry));
  const kept = lines.filter((entry) => keeperOf(entry));
  return [...(own.length > 0 ? [ownSteps(own, breach, floorsAt)] : []), ...(kept.length > 0 ? [keptSteps(kept)] : [])].join(" ");
}

/**
 * The planned campaign's. The store's setting reaches a campaign only until it starts (D21), and
 * one that started under Block was told to set Clamp or Skip there, which changed nothing until
 * it ended (#1161). It is told it keeps Block, and what does reach it: the floor, or a fresh
 * start under a setting that is not Block. Only when what it keeps is Block: one keeping Clamp or
 * Skip was stopped by something else, a cost it needs, and is told what it always was.
 */
function ownSteps(lines: readonly BlockedLine[], breach: BreachPolicy | undefined, floorsAt: string): string {
  const costs = costsOf(lines);
  const which = lines.length === 1 ? "this variant" : `these ${lines.length} variants`;
  // Its own choice of Block (#816): Settings never reaches it, started or not. Before it starts
  // it can choose again; once started it keeps it until it ends, as D21 says of any policy.
  if (breach?.own && breach.policy === "block") {
    return breach.kept
      ? `This campaign chose "${BREACH_POLICY_LABELS.block}" itself and keeps that until it ends, whatever Settings says. ` +
          `Lower or remove the floor ${floorsAt}${costs}, or revert the campaign, choose clamp or skip for it, and apply it again.`
      : `This campaign chose "${BREACH_POLICY_LABELS.block}" itself, whatever Settings says. Lower the floor ${floorsAt}, ` +
          `take ${which} out of the campaign's products${costs}, or choose clamp or skip for this campaign instead of blocking.`;
  }
  if (keepsBlock(breach)) {
    return (
      `This campaign started under "${BREACH_POLICY_LABELS.block}" and keeps that until it ends, whatever Settings says. ` +
      `Lower or remove the floor ${floorsAt}${costs}${startAgain("the campaign", breach.store)}.`
    );
  }
  return (
    `Lower the floor ${floorsAt}, take ${which} out of the campaign's products${costs}` +
    `, or set "When a price would breach a floor" to clamp or skip instead of blocking.`
  );
}

/**
 * Another running campaign's, kept on Block (#1169): a revert handing it a variant under the
 * floor, or a draft whose variant it wins. The same steps as the campaign's own, said of that
 * campaign by name: taking the variant out of the campaign planned, or changing the setting,
 * reaches nothing that stops it.
 */
function keptSteps(lines: readonly BlockedLine[]): string {
  const keepers = lines.map((entry) => keeperOf(entry)!);
  const names = [...new Set(keepers.map((by) => by.name))];
  const one = names.length === 1;
  const who = listed(names.map((name) => `"${name}"`));
  // One that chose Block itself (#816) is not given the store's policy by starting again.
  const chose = keepers.every((by) => by.breach.own);
  return (
    `${who} ${one ? "is a running campaign that" : "are running campaigns that each"} ${chose ? "chose" : "started under"} ` +
    `"${BREACH_POLICY_LABELS.block}" and keeps that until it ends, whatever Settings says. ` +
    `Lower or remove the floor in Settings${costsOf(lines)}` +
    `${chose ? `, or revert ${one ? who : "each"}, choose clamp or skip for it, and apply it again` : startAgain(one ? who : "each", keepers[0].breach.store)}.`
  );
}

/**
 * A fresh start for a campaign keeping Block, so it takes the store's policy now (#1161). Under a
 * store also on Block that alone would block again, so the setting comes first.
 */
function startAgain(which: string, store: BreachPolicy["store"]): string {
  return store === "block"
    ? `, or set "When a price would breach a floor" to clamp or skip, then revert ${which} and apply it again`
    : `, or revert ${which} and apply it again, so it starts under the store's policy now, "${BREACH_POLICY_LABELS[store]}"`;
}

/** "Record the missing costs" removes the cause whatever the policy. */
function costsOf(lines: readonly BlockedLine[]): string {
  return lines.some((entry) => entry.reason === "missing-cost") ? ", record the missing costs" : "";
}

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`; past five, "and N more". */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, BLOCKED_NAMED);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
