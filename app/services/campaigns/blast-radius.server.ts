import prisma from "../../db.server";
import { previewCampaign } from "./preview.server";
import { confirmationReasons, typedTheWord } from "../../lib/campaigns/blast-radius";
import { formatCount } from "../../lib/format/display";

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
 * Returns the refusal to show, or null to proceed. It re-previews rather than trusting a
 * count from the form for the obvious reason: the number a merchant was shown is not
 * necessarily the number that would be written now.
 *
 * The refusal is the dialog's own sentences (`confirmationReasons`), from the same preview
 * object, so the reasons a merchant is refused for are the reasons the dialog gave (#818).
 */
export async function blastRadiusRefusal(
  shopId: string,
  campaignId: string,
  typed: string,
): Promise<string | null> {
  // Answered without a plan wherever it can be (#803). The Apply POST planned the whole
  // campaign here and then `runCampaign` planned it again: on a 102,132-variant campaign,
  // two full loads of candidates and baselines before a price moved, in the pool the
  // pages and the run share. The word typed needs no plan to check -- and a campaign over
  // the variant threshold always asks for it, so the large ones are answered here.
  //
  // A small scope is planned now, where #803 let it through on a count. How far each price
  // moves is only known from the plan (#818): 95% off three variants writes three prices
  // and is exactly the campaign the word is for.
  if (typedTheWord(typed)) return null;

  const preview = await previewCampaign(shopId, campaignId);
  if (!preview.blastRadius) return null;

  const reasons = preview.confirm
    ? confirmationReasons(preview.confirm)
    : [`This campaign writes ${formatCount(preview.counts.planned)} prices.`];
  return `${reasons.join(" ")} Type \u201Capply\u201D in the confirmation box to run it.`;
}

/**
 * The typed confirmation for a press on the campaign page, or null to proceed.
 *
 * Apply asks for the word over the threshold, and so does Resume -- except on a campaign
 * whose run stopped part-way (#720). There it finishes a run that was already started, and
 * confirmed if it was over the threshold, of a campaign that cannot have been edited since;
 * and its button has no confirmation box, so the refusal asked the merchant to type into a
 * box the page does not have. Posted for any other campaign, "resume" is an apply under
 * another name, and is asked for the word like one.
 */
export async function pressRefusal(
  shopId: string,
  campaignId: string,
  intent: string,
  typed: string,
): Promise<string | null> {
  if (intent !== "apply" && intent !== "resume") return null;
  if (intent === "resume") {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true } });
    if (campaign?.status === "PARTIAL") return null;
  }
  return blastRadiusRefusal(shopId, campaignId, typed);
}
