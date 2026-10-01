/**
 * A revert too large for one request, handed to the worker (#772).
 *
 * Apply has always been bounded by `MAX_INLINE_ROWS`; revert never was, because the
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
import { formatCount } from "../../lib/format/display";
import { estimateMinutes } from "../../lib/execution/inline-budget";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { logger } from "../../lib/logging/logger";
import { enqueueWithin, webQueue } from "../../worker/web-queue.server";
import { releaseClaim, transitionCampaign } from "./lifecycle.server";
import type { RunOutcome } from "./types";

const nothing = { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true };

/**
 * The queued outcome, or null when there is no worker queue and the caller decides.
 *
 * Reverts since #772; applies since #773, for Flow, whose ten seconds an apply of a few
 * thousand variants already outlives.
 */
export async function queueRun(
  shopId: string,
  campaignId: string,
  rows: number,
  { revert, actor }: { revert: boolean; actor?: string },
): Promise<RunOutcome | null> {
  const verb = revert ? "reverting" : "applying";
  const queue = webQueue();
  if (!queue) {
    logger.warn("run larger than one request, but there is no worker queue", {
      shopId,
      campaignId,
      rows,
      revert,
    });
    return null;
  }

  const before = (
    await prisma.campaign.findFirstOrThrow({ where: { id: campaignId, shopId }, select: { status: true } })
  ).status as CampaignState;

  const claim = await transitionCampaign(shopId, campaignId, revert ? "REVERTING" : "APPLYING", {
    reason: `${revert ? "revert" : "apply"} handed to the background worker: ${formatCount(rows)} variants is more than one request can write`,
    actor,
  });
  if (!claim.changed) {
    // The work is already in hand, which is a deferral rather than a refusal: the merchant
    // or the automation asked for exactly what is happening.
    const message = `This campaign is already being ${revert ? "reverted" : "applied"}. Nothing more was queued; the Runs tab shows the run.`;
    return { ...nothing, messages: [message], deferredTo: "in-progress" };
  }

  try {
    await enqueueWithin(queue, "execution", { shopId, campaignId, revert, claimedFrom: before });
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

  const minutes = estimateMinutes(rows);
  return {
    ...nothing,
    queued: true,
    messages: [
      `This campaign covers ${formatCount(rows)} variants, which would take about ${minutes} ${minutes === 1 ? "minute" : "minutes"} — ` +
        `longer than a request is allowed to run. So the background worker is ${verb} it, with no ` +
        `time limit. It reads ${revert ? "Reverting" : "Applying"} until it finishes, and the Runs tab shows the result.`,
    ],
  };
}
