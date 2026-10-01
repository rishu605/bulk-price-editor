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
import { webQueue } from "../../worker/web-queue.server";
import { releaseClaim, transitionCampaign } from "./lifecycle.server";
import type { RunOutcome } from "./types";

/**
 * How long the request waits for Redis to take the job. The connection retries forever,
 * so without this a Redis outage would hang the request -- the very thing being avoided.
 */
export const ENQUEUE_TIMEOUT_MS = 10_000;

const nothing = { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true };

/** The queued outcome, or null when there is no worker queue and the caller runs it itself. */
export async function queueRevert(
  shopId: string,
  campaignId: string,
  rows: number,
  actor?: string,
): Promise<RunOutcome | null> {
  const queue = webQueue();
  if (!queue) {
    logger.warn("revert larger than one request, but there is no worker queue; running it inline", {
      shopId,
      campaignId,
      rows,
    });
    return null;
  }

  const before = (
    await prisma.campaign.findFirstOrThrow({ where: { id: campaignId, shopId }, select: { status: true } })
  ).status as CampaignState;

  const claim = await transitionCampaign(shopId, campaignId, "REVERTING", {
    reason: `revert handed to the background worker: ${formatCount(rows)} variants is more than one request can write`,
    actor,
  });
  if (!claim.changed) {
    const message = "This campaign is already being reverted. Nothing more was queued; the Runs tab shows the run.";
    return { ...nothing, messages: [message], refused: message };
  }

  try {
    await Promise.race([
      queue.enqueue("execution", { shopId, campaignId, revert: true, claimedFrom: before }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`no answer from the queue in ${ENQUEUE_TIMEOUT_MS}ms`)), ENQUEUE_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    await releaseClaim(shopId, campaignId, before, {
      reason: `the revert could not be handed to the worker: ${error instanceof Error ? error.message : String(error)}`,
      actor,
    });
    const message =
      "This revert is too large to run from here, and the background worker could not be reached, so nothing " +
      "was written. Try again in a minute. If it keeps happening, contact support from this page.";
    return { ...nothing, messages: [message], refused: message };
  }

  const minutes = estimateMinutes(rows);
  return {
    ...nothing,
    queued: true,
    messages: [
      `This campaign covers ${formatCount(rows)} variants, which would take about ${minutes} ${minutes === 1 ? "minute" : "minutes"} — ` +
        "longer than a request from this page is allowed to run. So the background worker is reverting it, with no " +
        "time limit. It reads Reverting until it finishes, and the Runs tab shows the result.",
    ],
  };
}
