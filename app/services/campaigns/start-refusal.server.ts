/**
 * Recording a scheduled start refused for good, and telling the merchant once (#975).
 *
 * Kept on the campaign, in its schedule beside the start it refused, before the scheduler's
 * claim is given back: from the moment the campaign is SCHEDULED again, the next tick has to
 * be able to see that this start is not worth claiming. See `lib/scheduling/start-refusal.ts`
 * for which failures count and why.
 */

import prisma from "../../db.server";
import { logger } from "../../lib/logging/logger";
import { withStartRefused } from "../../lib/scheduling/start-refusal";
import { notify } from "../notifications.server";

/**
 * Marks the campaign's current start refused, with the merchant's sentence for why.
 *
 * It does not throw. It runs inside the catch that rethrows the run's own failure, and a
 * database hiccup here must not replace that failure; the cost of losing the mark is one
 * more claim on the next tick, which records nothing new (`quietIfRepeated`).
 *
 * `tell` is false when the run had already started and `failRun` emailed about it.
 */
export async function recordStartRefused(
  shopId: string,
  campaignId: string,
  reason: string,
  options: { tell: boolean },
): Promise<void> {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { name: true, schedule: true },
    });
    if (!campaign) return;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { schedule: withStartRefused(campaign.schedule, reason, new Date()) as never },
    });

    // Once, because the mark above stops every later tick before it claims. A merchant who
    // asked to hear about failures had heard nothing at all: a run that never got as far as
    // a run row reaches no other sender.
    if (options.tell) {
      void notify(shopId, {
        kind: "run-failed",
        notStarted: true,
        campaignId,
        campaignName: campaign.name,
        counts: { verified: 0, failed: 0, unverified: 0, skipped: 0, clamped: 0 },
        reasons: [reason],
      });
    }
  } catch (error) {
    logger.warn("could not record a refused scheduled start", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
