import prisma from "../../db.server";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { pressPreview } from "./plan-summary.server";
import { confirmationReasons, typedTheWord } from "../../lib/campaigns/blast-radius";
import { formatCount } from "../../lib/format/display";

/**
 * Said when the stored preview an Apply was pressed over is out of date (#812): the dialog
 * showed it as out of date and asked for the word over it, and so does the server. Names the
 * object, the cause and the next action; no prices.
 */
export const STALE_PREVIEW_REFUSAL =
  "This campaign's preview is out of date: something it depends on changed after it was worked out, and it is " +
  "being worked out again, so nothing was written. Type “apply” in the confirmation box to run it as it is " +
  "now, or wait for the new preview.";

/**
 * Said when no preview of a campaign too large to plan in a request has been worked out yet
 * (#812): there is no number to have shown anyone, so the word is asked.
 */
export const UNPLANNED_REFUSAL =
  "This campaign's preview has not been worked out yet: it covers too many variants to plan while you wait, and " +
  "its campaign page plans it in the background, so nothing was written. Open the campaign to see its preview, or " +
  "type “apply” in the confirmation box to run it as it is now.";

/**
 * A-3.11's typed confirmation, checked on the server.
 *
 * The modal asks a merchant to type the word before a campaign over the blast-radius
 * threshold runs. That is a courtesy; this is the guard. A modal can be dismissed, a
 * field can be removed, and the same form can be posted from anywhere — a confirmation
 * that exists only in the browser is a confirmation for merchants who use the browser
 * the way we expected.
 *
 * Reverting is deliberately not gated. It is the way *back*, and putting friction between
 * a merchant and undo is the wrong side of that door to stand on.
 *
 * Returns the refusal to show, or null to proceed. It reads the campaign's stored preview
 * rather than trusting a count from the form, for the obvious reason: the number a merchant
 * was shown is not necessarily the number that would be written now.
 *
 * The refusal is the dialog's own sentences (`confirmationReasons`), from the same preview
 * object, so the reasons a merchant is refused for are the reasons the dialog gave (#818).
 */
export async function blastRadiusRefusal(
  shopId: string,
  campaignId: string,
  typed: string,
  client?: AdminClient,
): Promise<string | null> {
  // Answered without a plan wherever it can be (#803). The word typed needs no plan to check.
  if (typedTheWord(typed)) return null;

  // The stored preview, never a plan of this press's own once one is current (#812): the
  // Apply POST planned the whole campaign here and `runCampaign` planned it again -- two full
  // loads of candidates and baselines before a price moved, at 102,132 variants. How far each
  // price moves is still only known from a plan (#818); it is the stored one's answer, and the
  // run checks its own plan again before writing (`refuseUntypedPress`), so a stored number
  // can make this ask when it need not but can never be why the word was skipped.
  const preview = await pressPreview(shopId, campaignId, client);
  // No number anybody was shown is current: the word is asked, as the dialog asks it.
  if (preview.planning) return UNPLANNED_REFUSAL;
  if (preview.recomputing) return STALE_PREVIEW_REFUSAL;
  if (!preview.blastRadius) return null;

  const reasons = preview.confirm
    ? confirmationReasons(preview.confirm)
    : [`This campaign writes ${formatCount(preview.counts.planned)} prices.`];
  return `${reasons.join(" ")} Type “apply” in the confirmation box to run it.`;
}

/** What a press on the campaign page was asked, and what its run is to check again. */
export interface PressCheck {
  /** The refusal to show, or null to proceed. */
  refusal: string | null;
  /**
   * Proceeding with the word not typed, on a press that asks for it over the threshold: the
   * run checks its own plan before writing (#812). False for the presses that never ask.
   */
  untyped: boolean;
}

/**
 * The typed confirmation for a press on the campaign page.
 *
 * Apply asks for the word over the threshold, and so does Resume -- except on a campaign
 * whose run stopped part-way (#720). There it finishes a run that was already started, and
 * confirmed if it was over the threshold, of a campaign that cannot have been edited since;
 * and its button has no confirmation box, so the refusal asked the merchant to type into a
 * box the page does not have. Posted for any other campaign, "resume" is an apply under
 * another name, and is asked for the word like one.
 */
export async function pressCheck(
  shopId: string,
  campaignId: string,
  intent: string,
  typed: string,
  client?: AdminClient,
): Promise<PressCheck> {
  if (intent !== "apply" && intent !== "resume") return { refusal: null, untyped: false };
  if (intent === "resume") {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true } });
    if (campaign?.status === "PARTIAL") return { refusal: null, untyped: false };
  }
  const refusal = await blastRadiusRefusal(shopId, campaignId, typed, client);
  return { refusal, untyped: refusal === null && !typedTheWord(typed) };
}

/** `pressCheck`'s refusal alone. */
export async function pressRefusal(
  shopId: string,
  campaignId: string,
  intent: string,
  typed: string,
): Promise<string | null> {
  return (await pressCheck(shopId, campaignId, intent, typed)).refusal;
}
