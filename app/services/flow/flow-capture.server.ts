/**
 * Capturing baselines for Shopify Flow: the decision, and the capture itself (#773).
 *
 * Shared by the Flow action and the worker job it hands a large capture to, so the
 * worker refuses exactly what the action refuses. Between Flow asking and the worker
 * running, a campaign may have gone live -- and capturing then would record its sale
 * prices as the new normal, which is the one thing this action must never do.
 */

import prisma from "../../db.server";
import { PRICES_MAY_BE_LIVE } from "../../lib/lifecycle/transitions";
import { logger } from "../../lib/logging/logger";
import { planRecapture, recapture } from "../recapture.server";
import { FLOW_ACTOR } from "./flow-answer.server";

/** Why a capture cannot happen now, as Flow should show it, or null. */
export async function captureRefusal(shopId: string): Promise<string | null> {
  // HELD and REVERTING count (#708): drift holds a campaign with its sale prices still
  // live, and a revert in progress has not taken them all down yet.
  const running = await prisma.campaign.count({
    where: { shopId, status: { in: [...PRICES_MAY_BE_LIVE] } },
  });
  return running > 0
    ? `${running} ${running === 1 ? "campaign has" : "campaigns have"} prices live, so capturing now would record sale ` +
        "prices as the normal ones. Nothing was captured. End the campaigns first, or run this when none is live."
    : null;
}

/**
 * The capture, by the worker. Refuses quietly in the log rather than throwing when a
 * campaign went live in the meantime: a throw would be retried, and retrying will not end
 * the campaign.
 */
export async function captureForFlow(shopId: string, segmentId: string): Promise<number> {
  const refusal = await captureRefusal(shopId);
  if (refusal) {
    logger.warn("queued Flow capture skipped: a campaign went live first", { shopId, segmentId });
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: FLOW_ACTOR,
        action: "flow.capture-baselines",
        entity: "Segment",
        entityId: segmentId,
        after: { outcome: "refused", message: refusal } as never,
      },
    });
    return 0;
  }

  // The confirmation phrase is generated from the plan and handed straight back. The
  // check exists to make a *person* read the warning about live campaigns, which is the
  // condition refused above; what remains is the scope, which the automation named.
  const plan = await planRecapture(shopId, { segmentId });
  const result = await recapture(shopId, {
    segmentId,
    confirmation: plan.confirmationPhrase ?? undefined,
    actor: FLOW_ACTOR,
  });
  logger.info("Flow captured baselines", { shopId, captured: result.captured });
  return result.captured;
}
