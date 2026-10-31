/**
 * What an end that kept the prices edited outside Anchor says about them (#794).
 *
 * Shopify Flow's End campaign has nobody to ask which edits to keep, so it keeps every one:
 * the Revert button would have stopped and asked. Flow's run log, the campaign's history and
 * the kept rows in its ledger are where a merchant reads what the end did, so the words for
 * it live here, once.
 */

import { countOf } from "../format/display";

/** Why each kept row was left, on its ledger row. */
export const KEPT_EDIT_REASON =
  "Left as it is: this price was edited outside the app after the campaign set it, and Shopify Flow ends a " +
  "campaign without writing over an edit. The rest of the sale was reverted.";

/** "1 price edited outside Anchor was left as edited, not reverted." */
export function editsLeft(count: number): string {
  return `${countOf(count, "price")} edited outside Anchor ${count === 1 ? "was" : "were"} left as edited, not reverted.`;
}

/** For an end handed to the worker, which works out which prices are edited when it runs. */
export const EDITS_WILL_BE_LEFT = "Any price edited outside Anchor since the campaign set it is left as edited, not reverted.";
