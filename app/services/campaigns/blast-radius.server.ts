import { previewCampaign } from "./preview.server";
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
 */
export async function blastRadiusRefusal(
  shopId: string,
  campaignId: string,
  typed: string,
): Promise<string | null> {
  const preview = await previewCampaign(shopId, campaignId);
  if (!preview.blastRadius) return null;
  if (typed.trim().toLowerCase() === "apply") return null;

  return (
    `This campaign writes ${formatCount(preview.counts.planned)} prices. ` +
    `Type \u201Capply\u201D in the confirmation box to run it.`
  );
}
