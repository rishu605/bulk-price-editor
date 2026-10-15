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
import { withoutQueuedRefused, withQueuedRefused, type QueuedRefusal } from "../../lib/campaigns/queued-refusal";
import { endMissed, withEndMissed } from "../../lib/scheduling/end-missed";
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

/**
 * Records that a scheduled end could not run, and tells the merchant once (#1005).
 *
 * Unlike a refused start, the scheduler keeps trying: the sale's prices are live past its
 * window. This only makes the miss visible. Marked once per end, so a revert that fails on
 * every tick sends one email and leaves one sentence on the page, not one a tick. Does not
 * throw, for the reason `recordStartRefused` gives.
 */
export async function recordEndMissed(
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
    if (!campaign || endMissed(campaign.schedule) !== null) return;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { schedule: withEndMissed(campaign.schedule, reason, new Date()) as never },
    });

    if (options.tell) {
      void notify(shopId, {
        kind: "run-failed",
        notEnded: true,
        campaignId,
        campaignName: campaign.name,
        counts: { verified: 0, failed: 0, unverified: 0, skipped: 0, clamped: 0 },
        reasons: [reason],
      });
    }
  } catch (error) {
    logger.warn("could not record a missed scheduled end", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records a run the background worker was handed and could not run, and tells the merchant
 * once (#1046). The job is tried once (`execution`'s policy), so once a job is once a run.
 * Does not throw, for the reason `recordStartRefused` gives.
 *
 * `tell` is false when the run had already started and `failRun` emailed about it.
 */
export async function recordQueuedRefused(
  shopId: string,
  campaignId: string,
  refusal: QueuedRefusal,
  options: { tell: boolean },
): Promise<void> {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { name: true, schedule: true } });
    if (!campaign) return;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { schedule: withQueuedRefused(campaign.schedule, refusal, new Date()) as never },
    });

    // A refusal before the run row reaches no other sender: the merchant was told the worker
    // had it, and would otherwise hear nothing at all.
    if (options.tell) {
      void notify(shopId, {
        kind: "run-failed",
        queued: refusal.verb,
        revert: refusal.verb === "revert",
        campaignId,
        campaignName: campaign.name,
        counts: { verified: 0, failed: 0, unverified: 0, skipped: 0, clamped: 0 },
        reasons: [refusal.reason],
      });
    }
  } catch (error) {
    logger.warn("could not record a refused queued run", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Clears a recorded refusal once a later run has claimed the campaign (#1046). */
export async function clearQueuedRefused(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { schedule: true } });
  const cleared = withoutQueuedRefused(campaign?.schedule);
  if (cleared) await prisma.campaign.update({ where: { id: campaignId }, data: { schedule: cleared as never } });
}
