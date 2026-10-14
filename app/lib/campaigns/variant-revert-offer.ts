/**
 * Where "Revert this variant" can do what it says (#764).
 *
 * The ledger offered it on every row whose status was Verified or Applied, and nothing
 * else: not the run's kind, not the campaign's state, not which campaign the run belonged
 * to. So a campaign applied and then reverted -- Completed, nothing of it live -- showed
 * its revert's ledger with the button on every row. Pressing one wrote nothing visible, and
 * quietly took the variant out of the campaign for good, so the next time the merchant
 * applied it that variant was skipped without a word.
 *
 * The button needs three things to be true, and each is a fact about something other
 * than the row:
 *
 *   **The campaign is live.** Active, Held or Partial: it has prices up to take this
 *   variant back from. A draft has written nothing, a completed campaign has already put
 *   everything back, and one mid-run is being written by somebody else right now.
 *
 *   **The run is an apply.** Its rows are prices this campaign put on the storefront. A
 *   revert's rows are prices it took off, and "revert this" on one is a revert of a
 *   revert -- which is not what the button does, and not what anyone pressing it wants.
 *
 *   **The row landed.** Offering to undo a row that failed or was skipped would promise to
 *   undo something that never happened.
 *
 * Here rather than in the ledger component because the action checks the same three, and
 * a button offered by one rule and accepted by another is how a page comes to offer
 * something the server refuses -- or, worse, the reverse, which is this bug.
 */

import type { CampaignState } from "../lifecycle/transitions";
import { isLanded } from "../execution/landed";

/**
 * States in which a campaign has prices up that a single variant can be taken back from.
 *
 * `PRICING_STATES` without APPLYING: a run is writing, and a second writer for one of its
 * variants is what rule 2 exists to stop. The same three `reassertDrift` accepts, for the
 * same reason -- it is the other one-variant write on a running campaign.
 */
export const VARIANT_REVERT_STATES: ReadonlySet<CampaignState> = new Set<CampaignState>([
  "ACTIVE",
  "HELD",
  "PARTIAL",
]);

/**
 * A ledger row whose price this campaign put on the storefront, or handed to Shopify to
 * put there (#832: a bulk row reads Applied until Shopify's operation is read back).
 */
export function wroteThisRow(status: string): boolean {
  return isLanded(status) || status === "APPLIED";
}

/** Whether a ledger of this run, on a campaign in this state, offers the button at all. */
export function offersVariantRevert(state: CampaignState, runKind: string | null | undefined): boolean {
  return VARIANT_REVERT_STATES.has(state) && runKind === "APPLY";
}

/**
 * A variant's GID, as far as the action can tell from the form.
 *
 * `String(form.get("variantGid"))` turned a missing field into the string "null", and that
 * was pushed into the campaign's exclusions like any other variant. Checked for shape only
 * -- the id part is digits in Shopify and a seed name in the chaos fixtures -- because
 * whether the variant is one this campaign priced is a question for the ledger, not for a
 * pattern.
 */
export function isVariantGid(value: unknown): value is string {
  return typeof value === "string" && /^gid:\/\/shopify\/ProductVariant\/[^\s/?#]+$/.test(value);
}
