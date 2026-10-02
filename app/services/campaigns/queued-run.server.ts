/**
 * A run too long for one request, handed to the worker (#772, #790).
 *
 * Apply has always been bounded by the inline budget; revert never was, because the
 * check sat inside `if (!options.revert)`. Railway closes a silent request after five
 * minutes and the writes carry on with nobody reading the result -- `inline-budget.ts`
 * calls that the one outcome this product exists to prevent. A revert cannot be refused
 * instead, though: ending a sale must always be possible. So it is a scheduling question,
 * as the budget's own comment says an oversized apply is, and the worker answers it.
 *
 * Claimed before it is queued. The campaign reads Reverting from the moment the merchant
 * presses the button, a second press finds it already claimed rather than queueing a
 * second revert, and the worker's run is given the state it was claimed from so a failure
 * before it starts puts the campaign back.
 */

import prisma from "../../db.server";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { logger } from "../../lib/logging/logger";
import { enqueueWithin, webQueue } from "../../worker/web-queue.server";
import { releaseClaim, transitionCampaign } from "./lifecycle.server";
import type { RunOutcome } from "./types";

export interface QueuedRunOptions {
  revert: boolean;
  resume?: boolean;
  actor?: string;
  /** The rollback report's "leave as it is" (#790): carried to the worker, never dropped. */
  skipVariantGids?: string[];
  skipReason?: string;
}

const nothing = { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true };

/**
 * The queued outcome, or null when there is no worker queue and the caller decides.
 *
 * Reverts since #772; applies since #773, for Flow, whose ten seconds an apply of a few
 * thousand variants already outlives; and since #790 anything from the campaign page that
 * would outlive its five minutes, which includes every run that takes the bulk path.
 */
export async function queueRun(
  shopId: string,
  campaignId: string,
  /** Why it cannot run here, from `overBudget`: names the size and the reason. */
  reason: string,
  { revert, actor, resume, skipVariantGids, skipReason }: QueuedRunOptions,
): Promise<RunOutcome | null> {
  const verb = revert ? "reverting" : "applying";
  const queue = webQueue();
  if (!queue) {
    logger.warn("run longer than one request, but there is no worker queue", { shopId, campaignId, revert });
    return null;
  }

  const before = (
    await prisma.campaign.findFirstOrThrow({ where: { id: campaignId, shopId }, select: { status: true } })
  ).status as CampaignState;

  const claim = await transitionCampaign(shopId, campaignId, revert ? "REVERTING" : "APPLYING", {
    reason: `${revert ? "revert" : resume ? "resume" : "apply"} handed to the background worker: ${reason}`,
    actor,
  });
  if (!claim.changed) {
    // The work is already in hand, which is a deferral rather than a refusal: the merchant
    // or the automation asked for exactly what is happening.
    const message = `This campaign is already being ${revert ? "reverted" : "applied"}. Nothing more was queued; the Runs tab shows the run.`;
    return { ...nothing, messages: [message], deferredTo: "in-progress" };
  }

  try {
    // Everything the request would have run with. A revert that dropped the merchant's
    // "leave as it is" ticks on the way to the worker would overwrite the very edits they
    // asked to keep, and a resume that arrived as an apply would rewrite verified rows.
    await enqueueWithin(queue, "execution", {
      shopId,
      campaignId,
      revert,
      claimedFrom: before,
      ...(resume ? { resume } : {}),
      ...(actor ? { actor } : {}),
      ...(skipVariantGids?.length ? { skipVariantGids, skipReason } : {}),
    });
  } catch (error) {
    await releaseClaim(shopId, campaignId, before, {
      reason: `the ${revert ? "revert" : "apply"} could not be handed to the worker: ${error instanceof Error ? error.message : String(error)}`,
      actor,
    });
    const message =
      `This ${revert ? "revert" : "apply"} is too large to run from here, and the background worker could not be reached, so nothing ` +
      "was written. Try again in a minute. If it keeps happening, contact support from this page.";
    return { ...nothing, messages: [message], refused: message, transient: true };
  }

  return {
    ...nothing,
    queued: true,
    messages: [
      `${reason} So the background worker is ${verb} it, with no time limit. It reads ` +
        `${revert ? "Reverting" : "Applying"} until it finishes, and the Runs tab shows the result.`,
    ],
  };
}
