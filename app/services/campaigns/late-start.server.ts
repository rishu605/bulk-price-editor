import prisma from "../../db.server";
import { parseSchedule } from "../../lib/scheduling/window";

const RELEASED = "claim released without running: ";

/** How long past its start a campaign may sit before the page stops calling it waiting. */
const GRACE_MS = 2 * 60_000;

/**
 * Why a scheduled campaign past its start has not started, or null while it is not late
 * (#851).
 *
 * The scheduler releases a claim it cannot run -- waiting for approval, a plan refused --
 * and tries again next tick, recording the reason once. The Status card went on saying
 * "Waiting for its start time" over a window that had opened, with the real reason only in
 * the history further down. Only reasons recorded since the start count: an older entry is
 * about some other attempt.
 */
export async function lateStart(
  shopId: string,
  campaignId: string,
  schedule: unknown,
  now: Date = new Date(),
): Promise<string | null> {
  const window = parseSchedule(schedule);
  if (window.kind !== "window") return null;
  const startAt = Date.parse(window.startAt);
  if (!Number.isFinite(startAt) || now.getTime() < startAt) return null;

  const latest = await prisma.auditLogEntry.findFirst({
    where: {
      shopId,
      entity: "Campaign",
      entityId: campaignId,
      action: "campaign.transition",
      createdAt: { gte: new Date(startAt) },
    },
    orderBy: { createdAt: "desc" },
    select: { after: true },
  });
  const reason = (latest?.after as { reason?: string } | null)?.reason;
  if (reason) return reason.startsWith(RELEASED) ? reason.slice(RELEASED.length) : reason;

  return now.getTime() - startAt > GRACE_MS
    ? "The scheduler has not picked it up yet, and has recorded no reason."
    : null;
}
