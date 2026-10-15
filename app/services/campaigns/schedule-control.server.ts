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
import { definitionOf, manualSchedule } from "../../lib/campaigns/schedule-blob";
import { START_CONFIRMED_KEY, type StartConfirmation } from "../../lib/campaigns/start-confirmation";
import { describeState, type CampaignState } from "../../lib/lifecycle/transitions";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { formatScheduleInstant } from "../../lib/scheduling/window";
import { windowInputProblem } from "../../lib/scheduling/window-input";
import { windowInStoreZone } from "../shop-timezone.server";
import { transitionCampaign } from "./lifecycle.server";
import { confirmStart, saveStart } from "./start-confirmation.server";
import { keepShownTimes, keepTypedTimes } from "./zone-shift.server";

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

/**
 * Called off for good. A cancelled campaign never runs; it can be duplicated into a new
 * draft, which is how "the same sale, another month" is meant to be made.
 */
export async function cancelScheduled(shopId: string, campaignId: string, actor: string): Promise<string> {
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
export async function unschedule(
  shopId: string,
  campaignId: string,
  actor: string,
  reason = "unscheduled before it started",
): Promise<string> {
  const campaign = await scheduled(shopId, campaignId);

  const result = await transitionCampaign(shopId, campaignId, "DRAFT", { reason, actor });
  if (!result.changed) throw notScheduled(campaign.name, result.from);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { schedule: manualSchedule(campaign.schedule) as never, startAt: null, endAt: null },
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
 * with `windowInputProblem`, future start included, and its start with `saveStart`:
 * `confirmation` is the typed confirmation that check asked for, when it asked (#1009).
 * One it did not ask for again stays, since moving the dates changes nothing it writes.
 */
export async function reschedule(
  shopId: string,
  campaignId: string,
  window: { startUtc: string; endUtc: string | null; clockNotes: string[]; zone: string },
  actor: string,
  confirmation?: StartConfirmation,
): Promise<string> {
  const campaign = await scheduled(shopId, campaignId);
  const previous = (campaign.schedule ?? {}) as Record<string, unknown>;

  const updated = await prisma.campaign.updateMany({
    // Conditional on SCHEDULED: a tick that claimed it a moment ago has started the sale,
    // and moving the dates under a running apply would describe a window it is not in.
    where: { id: campaignId, shopId, status: "SCHEDULED" },
    data: {
      schedule: {
        ...definitionOf(previous),
        kind: "window",
        startAt: window.startUtc,
        ...(window.endUtc ? { endAt: window.endUtc } : {}),
        ...(previous.revertBufferMinutes !== undefined ? { revertBufferMinutes: previous.revertBufferMinutes } : {}),
        ...(window.clockNotes.length > 0 ? { clockNotes: window.clockNotes } : {}),
        // The zone the new dates were typed in (#799).
        zone: window.zone,
        ...(confirmation ? { [START_CONFIRMED_KEY]: confirmation } : {}),
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
      after: { startAt: window.startUtc, endAt: window.endUtc, ...(confirmation ? { startConfirmed: confirmation } : {}) } as never,
    },
  });

  return `"${campaign.name}" has new dates.`;
}

const SCHEDULE_INTENTS = new Set(["cancel-schedule", "unschedule", "reschedule", "keep-typed-time", "keep-shown-time"]);

/**
 * The campaign page's schedule intents, answered before any of the machinery that prices,
 * the way `housekeepingAction` answers its own. Null for any other intent. With them, the
 * confirmation that lets the scheduler and Flow start it (#1009), which writes no price either.
 *
 * A refusal -- the campaign started a moment ago, or the dates cannot run -- comes back as
 * a message on the page rather than an error screen: the merchant can act on it there.
 *
 * `client` is for the store's zone, asked of Shopify only by the intents that read a time
 * of day (#799): new dates are typed on the store's clock, and keeping the time a campaign
 * was set for means keeping it on the clock the store is on now.
 */
export async function scheduleAction(
  shopId: string,
  campaignId: string,
  intent: string,
  form: FormData,
  client: AdminClient,
  actor: string,
): Promise<{ ok: boolean; message: string } | null> {
  if (intent === "confirm-start") return confirmStart(shopId, campaignId, String(form.get("confirmation") ?? ""), actor);
  if (!SCHEDULE_INTENTS.has(intent)) return null;

  try {
    if (intent === "cancel-schedule") return { ok: true, message: await cancelScheduled(shopId, campaignId, actor) };
    if (intent === "unschedule") return { ok: true, message: await unschedule(shopId, campaignId, actor) };
    // After the store's zone changed under a campaign's times (#799).
    if (intent === "keep-typed-time") return await keepTypedTimes(shopId, campaignId, client, actor);
    if (intent === "keep-shown-time") return await keepShownTimes(shopId, campaignId, String(form.get("zone") ?? ""), actor);

    const field = (name: string) => String(form.get(name) ?? "");
    const typedIn = await windowInStoreZone(
      shopId,
      client,
      actor,
      { startDate: field("startDate"), startTime: field("startTime"), endDate: field("endDate"), endTime: field("endTime") },
      "The dates were not changed.",
    );
    if (!typedIn.ok) return { ok: false, message: typedIn.message };
    const { zone, ...window } = typedIn;
    if (!window.startUtc || !zone) {
      return {
        ok: false,
        message: "Start: a scheduled campaign needs a start date. To take its dates away, use Unschedule instead. The dates were not changed.",
      };
    }
    const problem = windowInputProblem({
      ...window,
      now: new Date(),
      futureStart: true,
      describe: (iso) => `${formatScheduleInstant(iso, zone)} (${zone})`,
    });
    if (problem) return { ok: false, message: `${problem} The dates were not changed.` };

    // New dates are a save of its start, which the scheduler makes with nobody there to type
    // the word (#1009): asked here when the start would be refused without it.
    const stored = await prisma.campaign.findFirst({ where: { id: campaignId, shopId } });
    const start = stored ? await saveStart(shopId, stored, field("confirmation"), actor) : { ok: true as const };
    if (!start.ok) {
      return { ok: false, message: `${start.unconfirmed} Type “apply” in the box to confirm it as it is now. The dates were not changed.` };
    }

    const message = await reschedule(shopId, campaignId, { ...window, startUtc: window.startUtc, zone }, actor, start.confirmation);
    return { ok: true, message: [message, ...window.clockNotes].join(" ") };
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION") return { ok: false, message: error.userMessage };
    throw error;
  }
}
