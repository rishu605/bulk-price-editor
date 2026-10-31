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
}

/** How many variants are named before "and N more". */
export const BLOCKED_NAMED = 5;

function line({ title, reason, wouldBe, floor }: BlockedLine): string {
  // With its currency, as every price a merchant reads is (#759): "$0.33", not "0.33".
  const price = (value: Money) => formatPrice(value.amount, value.currency);
  if (wouldBe && floor) return `"${title}" would be ${price(wouldBe)}, under its ${price(floor)} floor`;
  const phrase = SKIP_REASON_ROW[reason as ResolutionReason];
  return `"${title}": ${phrase ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : "it breaches a guardrail"}`;
}

/**
 * The sentence. `when` is "preview" for a plan nothing has run yet -- the campaign page and the
 * editor -- and "run" for a run it stopped, which the history, the scheduler and Flow read.
 * `breach` is the planned campaign's floor-breach policy as `breachPolicyFor` reads it, which
 * decides what it is told to do (#1161); none where the store's setting decides it.
 */
export function blockedMessage(lines: readonly BlockedLine[], when: "preview" | "run", breach?: BreachPolicy): string {
  const named = lines.slice(0, BLOCKED_NAMED).map(line);
  const rest = lines.length - named.length;
  const list = named.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
  const opening =
    when === "run"
      ? "A guardrail stopped this run before anything was written"
      : "A guardrail set to block the whole campaign would stop it before anything is written";
  return `${opening}: ${list}. ${nextSteps(lines, breach)}`;
}

/**
 * What to do. The store's setting reaches a campaign only until it starts (D21), and one that
 * started under Block was told to set Clamp or Skip there, which changed nothing until it ended
 * (#1161). It is told it keeps Block, and what does reach it: the floor, or a fresh start under
 * a setting that is not Block. Only when what it keeps is Block: one keeping Clamp or Skip was
 * stopped by something else, another campaign's Block or a cost it needs, and is told what it
 * always was.
 */
function nextSteps(lines: readonly BlockedLine[], breach?: BreachPolicy): string {
  const costs = lines.some((entry) => entry.reason === "missing-cost") ? ", record the missing costs" : "";
  if (breach?.kept && breach.policy === "block") {
    const again =
      breach.store === "block"
        ? `, or set "When a price would breach a floor" to clamp or skip, then revert the campaign and apply it again`
        : `, or revert the campaign and apply it again, so it starts under the store's policy now, "${BREACH_POLICY_LABELS[breach.store]}"`;
    return (
      `This campaign started under "${BREACH_POLICY_LABELS.block}" and keeps that until it ends, whatever Settings says. ` +
      `Lower or remove the floor in Settings${costs}${again}.`
    );
  }
  const which = lines.length === 1 ? "this variant" : `these ${lines.length} variants`;
  return (
    `Lower the floor in Settings, take ${which} out of the campaign's products${costs}` +
    `, or set "When a price would breach a floor" to clamp or skip instead of blocking.`
  );
}
