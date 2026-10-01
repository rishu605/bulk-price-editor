/**
 * Calling off or moving a scheduled campaign before it starts (#760).
 *
 * The state machine always allowed `SCHEDULED -> DRAFT | CANCELLED`, and nothing ever asked
 * for either. A merchant whose "Black Friday 2026" plans changed could let it go live and
 * revert it at once -- a real price change customers may see -- or leave it and hope. A
 * typo in the date had the same two options.
 *
 * None of this writes a price. Each change is conditional on the campaign still being
 * SCHEDULED when it lands, so it cannot overtake the scheduler claiming the campaign to
 * apply it: whichever reads SCHEDULED first wins, and the other is told plainly.
 */

import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import { describeState, type CampaignState } from "../../lib/lifecycle/transitions";
import { formatScheduleInstant } from "../../lib/scheduling/window";
import { windowFromFields, windowInputProblem } from "../../lib/scheduling/window-input";
import { transitionCampaign } from "./lifecycle.server";

/** What `createCampaign` keeps beside the window in the schedule blob, and must survive. */
const WINDOW_KEYS = ["kind", "startAt", "endAt", "revertBufferMinutes", "clockNotes"] as const;

async function scheduled(shopId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { id: true, name: true, status: true, schedule: true, startAt: true, endAt: true },
  });
  if (!campaign) {
    throw new AppError({ code: "NOT_FOUND", userMessage: "That campaign no longer exists. Reload the page." });
  }
  if (campaign.status !== "SCHEDULED") throw notScheduled(campaign.name, campaign.status as CampaignState);
  return campaign;
}

function notScheduled(name: string, status: CampaignState): AppError {
  return new AppError({
    code: "VALIDATION",
    userMessage:
      `"${name}" is ${describeState(status).label.toLowerCase()}, not scheduled, so there is no schedule to change. ` +
      "Nothing was changed. Reload the page to see where it is now.",
  });
}

/** The schedule blob with its window removed: what a manual campaign carries. */
function withoutWindow(schedule: unknown): Record<string, unknown> {
  const rest = { ...((schedule ?? {}) as Record<string, unknown>) };
  for (const key of WINDOW_KEYS) delete rest[key];
  return rest;
}

/**
 * Called off for good. A cancelled campaign never runs; it can be duplicated into a new
 * draft, which is how "the same sale, another month" is meant to be made.
 */
export async function cancelScheduled(shopId: string, campaignId: string, actor?: string): Promise<string> {
  const campaign = await scheduled(shopId, campaignId);

  const result = await transitionCampaign(shopId, campaignId, "CANCELLED", {
    reason: "cancelled before it started",
    actor,
  });
  if (!result.changed) throw notScheduled(campaign.name, result.from);

  return `"${campaign.name}" is cancelled. It will not start, and no price was changed.`;
}

/**
 * Back to a draft with no dates. Nothing runs until somebody schedules or applies it.
 *
 * The dates go with it: a draft that kept its window would revert on the old end date the
 * first time it was applied by hand.
 */
export async function unschedule(shopId: string, campaignId: string, actor?: string): Promise<string> {
  const campaign = await scheduled(shopId, campaignId);

  const result = await transitionCampaign(shopId, campaignId, "DRAFT", {
    reason: "unscheduled before it started",
    actor,
  });
  if (!result.changed) throw notScheduled(campaign.name, result.from);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { schedule: { ...withoutWindow(campaign.schedule), kind: "manual" } as never, startAt: null, endAt: null },
  });
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: actor ?? null,
      action: "campaign.unschedule",
      entity: "Campaign",
      entityId: campaignId,
      before: { startAt: campaign.startAt?.toISOString() ?? null, endAt: campaign.endAt?.toISOString() ?? null } as never,
    },
  });

  return `"${campaign.name}" is a draft again, with no dates. Nothing will run until you schedule or apply it.`;
}

/**
 * New dates for a campaign that has not started. The caller has already checked them
 * with `windowInputProblem`, future start included.
 */
export async function reschedule(
  shopId: string,
  campaignId: string,
  window: { startUtc: string; endUtc: string | null; clockNotes: string[] },
  actor?: string,
): Promise<string> {
  const campaign = await scheduled(shopId, campaignId);
  const previous = (campaign.schedule ?? {}) as Record<string, unknown>;

  const updated = await prisma.campaign.updateMany({
    // Conditional on SCHEDULED: a tick that claimed it a moment ago has started the sale,
    // and moving the dates under a running apply would describe a window it is not in.
    where: { id: campaignId, shopId, status: "SCHEDULED" },
    data: {
      schedule: {
        ...withoutWindow(previous),
        kind: "window",
        startAt: window.startUtc,
        ...(window.endUtc ? { endAt: window.endUtc } : {}),
        ...(previous.revertBufferMinutes !== undefined ? { revertBufferMinutes: previous.revertBufferMinutes } : {}),
        ...(window.clockNotes.length > 0 ? { clockNotes: window.clockNotes } : {}),
      } as never,
      startAt: new Date(window.startUtc),
      endAt: window.endUtc ? new Date(window.endUtc) : null,
    },
  });
  if (updated.count === 0) {
    const now = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { status: true } });
    throw notScheduled(campaign.name, now.status as CampaignState);
  }

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: actor ?? null,
      action: "campaign.reschedule",
      entity: "Campaign",
      entityId: campaignId,
      before: { startAt: campaign.startAt?.toISOString() ?? null, endAt: campaign.endAt?.toISOString() ?? null } as never,
      after: { startAt: window.startUtc, endAt: window.endUtc } as never,
    },
  });

  return `"${campaign.name}" has new dates.`;
}

/**
 * The campaign page's three schedule intents, answered before any of the machinery that
 * prices, the way `housekeepingAction` answers its own. Null for any other intent.
 *
 * A refusal -- the campaign started a moment ago, or the dates cannot run -- comes back as
 * a message on the page rather than an error screen: the merchant can act on it there.
 */
export async function scheduleAction(
  shopId: string,
  campaignId: string,
  intent: string,
  form: FormData,
  timeZone: string,
  actor?: string,
): Promise<{ ok: boolean; message: string } | null> {
  if (intent !== "cancel-schedule" && intent !== "unschedule" && intent !== "reschedule") return null;

  try {
    if (intent === "cancel-schedule") return { ok: true, message: await cancelScheduled(shopId, campaignId, actor) };
    if (intent === "unschedule") return { ok: true, message: await unschedule(shopId, campaignId, actor) };

    const field = (name: string) => String(form.get(name) ?? "");
    const window = windowFromFields(
      { startDate: field("startDate"), startTime: field("startTime"), endDate: field("endDate"), endTime: field("endTime") },
      timeZone,
    );
    if (!window.startUtc) {
      return {
        ok: false,
        message: "Start: a scheduled campaign needs a start date. To take its dates away, use Unschedule instead. The dates were not changed.",
      };
    }
    const problem = windowInputProblem({
      ...window,
      now: new Date(),
      futureStart: true,
      describe: (iso) => `${formatScheduleInstant(iso, timeZone)} (${timeZone})`,
    });
    if (problem) return { ok: false, message: `${problem} The dates were not changed.` };

    const message = await reschedule(shopId, campaignId, { ...window, startUtc: window.startUtc }, actor);
    return { ok: true, message: [message, ...window.clockNotes].join(" ") };
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION") return { ok: false, message: error.userMessage };
    throw error;
  }
}
