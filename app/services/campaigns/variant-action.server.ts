/**
 * The campaign page's two per-variant presses -- Revert this variant, and its undo --
 * checked before either one writes (#764).
 *
 * The action trusted the form. `String(form.get("variantGid"))` sent a missing field
 * through as the string "null"; nothing asked what state the campaign was in, so a draft
 * or a finished campaign took the press like a running one; and nothing asked whether the
 * variant was this campaign's at all. The ledger it came from could be any run the URL
 * named -- another campaign's, a revert's -- so its buttons posted that run's variants here,
 * and each one was excluded from this campaign for good and given a scoped revert of a
 * campaign that may never have priced it.
 *
 * Exclusion is the part that matters. It is permanent and silent: the variant is skipped
 * by every later run, scheduled or pressed, and nothing on the page says so. So everything
 * the ledger checks before drawing the button is checked again here, from the database
 * rather than from anything the request says, and a press that fails any of it changes
 * nothing.
 *
 * Out of the route because the route is against its own length limit, and because a
 * refusal written next to the rules in `variant-revert-offer.ts` is one that stays in step
 * with them.
 */

import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { LANDED } from "../../lib/execution/landed";
import { isVariantGid, VARIANT_REVERT_STATES } from "../../lib/campaigns/variant-revert-offer";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { reinstateVariant, revertVariant } from "./variant-revert.server";

const INTENTS = new Set(["revert-variant", "reinstate-variant"]);

export interface VariantActionResponse {
  ok: boolean;
  message: string;
  details: string[];
}

/**
 * Answers `revert-variant` and `reinstate-variant`; null for every other intent.
 *
 * Throws a VALIDATION `AppError` for a press that must not run, which the route's own
 * error handling turns into a banner without filing it as a fault: nothing broke, and the
 * merchant is told what to do instead.
 */
export async function variantAction(
  shopId: string,
  campaignId: string,
  intent: string,
  form: FormData,
  client: AdminClient,
  actor: string,
): Promise<VariantActionResponse | null> {
  if (!INTENTS.has(intent)) return null;

  const variantGid = form.get("variantGid");
  if (!isVariantGid(variantGid)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "That request did not name a variant, so nothing was changed. " +
        "Reload the campaign and press the button on the variant's ledger row again.",
      context: { campaignId, intent, variantGid: typeof variantGid === "string" ? variantGid : null },
    });
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { name: true, status: true },
  });
  if (!campaign) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage:
        "That campaign no longer exists, so there is nothing to revert this variant out of. Reload the page.",
      context: { campaignId, variantGid },
    });
  }

  const state = campaign.status as CampaignState;
  if (!VARIANT_REVERT_STATES.has(state)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: notLive(campaign.name, state, intent),
      context: { campaignId, variantGid, intent, state },
    });
  }

  // A price this campaign put on the storefront, by any of its applies -- not only the one
  // on screen, which may be older than the twenty runs the page lists. Taken from the
  // ledger and nothing else: a run id in the URL is a claim, the ledger is the record.
  if (intent === "revert-variant") {
    const wrote = await prisma.variantChange.findFirst({
      where: {
        shopId,
        variantGid,
        status: { in: [...LANDED, "APPLIED"] },
        run: { campaignId, kind: "APPLY" },
      },
      select: { id: true },
    });
    if (!wrote) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          `"${campaign.name}" has never written a price for this variant, so there is nothing of its to revert. ` +
          "Nothing was changed: the variant was not taken out of the campaign. Reload the page; if another " +
          "campaign priced this variant, revert it from that campaign's ledger.",
        context: { campaignId, variantGid },
      });
    }
  }

  const result =
    intent === "revert-variant"
      ? await revertVariant(shopId, campaignId, variantGid, client, {
          actor,
          excludeOnly: form.get("excludeOnly") === "1",
        })
      : await reinstateVariant(shopId, campaignId, variantGid, client, { actor });

  return {
    ok: result.outcome ? result.outcome.clean : true,
    message: result.message,
    details: result.outcome?.messages ?? [],
  };
}

/**
 * Why a campaign in this state takes no per-variant press, and what to do instead.
 *
 * Mid-run is its own answer: the campaign is live and the press may well be right, just
 * not while another writer holds it. Everything else has no price up to take back.
 */
function notLive(name: string, state: CampaignState, intent: string): string {
  const kept =
    intent === "revert-variant"
      ? "Nothing was changed: the variant was not taken out of the campaign."
      : "Nothing was changed: the variant was not put back into the campaign.";

  if (state === "APPLYING" || state === "REVERTING") {
    return (
      `"${name}" is being ${state === "APPLYING" ? "applied" : "reverted"} right now. ${kept} ` +
      "Wait for that run to finish, then reload the page."
    );
  }

  const why =
    state === "COMPLETED"
      ? "has been reverted, so its prices are already off your storefront"
      : state === "CANCELLED"
        ? "is cancelled, so it has no prices on your storefront"
        : "has not been applied, so it has no prices on your storefront";
  return intent === "revert-variant"
    ? `"${name}" ${why}. ${kept} To leave this variant out of a later apply, edit which products the campaign applies to.`
    : `"${name}" ${why}. ${kept}`;
}
