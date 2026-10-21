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
 */
export function blockedMessage(lines: readonly BlockedLine[], when: "preview" | "run"): string {
  const named = lines.slice(0, BLOCKED_NAMED).map(line);
  const rest = lines.length - named.length;
  const list = named.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
  const which = lines.length === 1 ? "this variant" : `these ${lines.length} variants`;
  const opening =
    when === "run"
      ? "A guardrail stopped this run before anything was written"
      : "A guardrail set to block the whole campaign would stop it before anything is written";
  const missingCost = lines.some((entry) => entry.reason === "missing-cost");
  return (
    `${opening}: ${list}. ` +
    `Lower the floor in Settings, take ${which} out of the campaign's products` +
    (missingCost ? ", record the missing costs" : "") +
    `, or set "When a price would breach a floor" to clamp or skip instead of blocking.`
  );
}
