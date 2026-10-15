/**
 * Telling the merchant, once, that a campaign is still applying past the moment its revert
 * was due (#829). See `lib/scheduling/ending-late.ts` for why the end has to wait.
 *
 * Two things watch for it, because either can be the one with the time: the apply itself,
 * on its heartbeat -- the scheduler runs a scheduled apply inside its tick, so no tick looks
 * while it writes -- and the tick, for an apply the worker's queue is running, or one still
 * being planned. Whichever sees it first tells the merchant; the other finds it told.
 */

import prisma from "../../db.server";
import { logger } from "../../lib/logging/logger";
import {
  ENDING_LATE_ENTRY,
  isEndingLate,
  toldEndingLate,
  withEndingLate,
} from "../../lib/scheduling/ending-late";
import { parseSchedule, revertMoment } from "../../lib/scheduling/window";
import { notify } from "../notifications.server";
import { noteCampaign } from "./lifecycle.server";
import { HEARTBEAT_EVERY_MS } from "./reaper.server";

/**
 * What a call found: it told the merchant, they had been told already, the campaign is not
 * ending late (finished, or its end moved), or it could not tell and the caller should ask
 * again.
 */
export type EndingLateOutcome = "told" | "already" | "not-late" | "retry";

/**
 * Records that the campaign is ending late, says so in its history and emails the merchant,
 * once per end. Does not throw: it runs beside an apply that must not fail over it.
 */
export async function recordEndingLate(shopId: string, campaignId: string, now: Date = new Date()): Promise<EndingLateOutcome> {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { name: true, status: true, schedule: true, updatedAt: true },
    });
    if (!campaign || !isEndingLate(parseSchedule(campaign.schedule), campaign.status, now)) return "not-late";
    if (toldEndingLate(campaign.schedule)) return "already";

    // Conditional on nothing having changed since it was read. The run and the tick both
    // watch, and only the one whose write lands tells the merchant; the other asks again
    // and finds it told.
    const marked = await prisma.campaign.updateMany({
      where: { id: campaignId, shopId, status: "APPLYING", updatedAt: campaign.updatedAt },
      data: { schedule: withEndingLate(campaign.schedule, now) as never },
    });
    if (marked.count === 0) return "retry";

    await noteCampaign(shopId, campaignId, ENDING_LATE_ENTRY);
    void notify(shopId, {
      kind: "run-failed",
      endingLate: true,
      campaignId,
      campaignName: campaign.name,
      counts: { verified: 0, failed: 0, unverified: 0, skipped: 0, clamped: 0 },
    });
    return "told";
  } catch (error) {
    logger.warn("could not record a campaign ending late", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "retry";
  }
}

/**
 * For a whole-campaign apply: asks, as the run beats, whether its revert has come due, and
 * tells the merchant the first time it has. A campaign with no end never asks.
 *
 * Throttled like the heartbeat, because the sync path beats once a product; until the
 * revert moment it costs a clock reading and nothing else. Done once the merchant has been
 * told. "Not late" is asked again: the end moved later while this run was going, and may
 * still come due before it finishes.
 */
export function endingLateWatch(
  shopId: string,
  campaignId: string,
  schedule: unknown,
  everyMs = HEARTBEAT_EVERY_MS,
): () => Promise<void> {
  const due = revertMoment(parseSchedule(schedule));
  let settled = due === null;
  let last = 0;

  return async () => {
    const now = Date.now();
    if (settled || now < due! || now - last < everyMs) return;
    last = now;
    const outcome = await recordEndingLate(shopId, campaignId, new Date(now));
    settled = outcome === "told" || outcome === "already";
  };
}
