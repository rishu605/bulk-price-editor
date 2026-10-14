/**
 * Campaigns whose times were set in a zone the store is no longer in (#799).
 *
 * A change of zone never moves a sale: its times are UTC instants. It moves the sale's
 * local time instead, and that was silent -- a 9 AM sale typed while Anchor had the store
 * in UTC opened at 4 AM once the first sync wrote New York. These find the campaigns that
 * now start or end at a different time on the store's clock, say so, and do whichever the
 * merchant chooses: keep the time they set, now in the store's zone, or keep the new one.
 *
 * Neither writes a price. Both are conditional on the campaign being where it was when it
 * was read, so they cannot overtake the scheduler claiming it.
 */

import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { formatScheduleInstant, parseSchedule } from "../../lib/scheduling/window";
import { windowInputProblem } from "../../lib/scheduling/window-input";
import { describeZoneShift, keptWallClock, zoneShiftOf } from "../../lib/scheduling/zone-shift";
import { confirmShopTimezone, unknownZoneMessage } from "../shop-timezone.server";

/** Statuses with a time still ahead that a change of zone can move on the clock. */
const OPEN = ["SCHEDULED", "ACTIVE", "HELD", "PARTIAL"] as const;

/**
 * Every campaign whose time of day reads differently on the store's clock now, with the
 * sentence saying how. For Home, which tells the merchant; the choice is on each page.
 */
export async function shiftedCampaigns(
  shopId: string,
  storeZone: string,
  now: Date = new Date(),
): Promise<Array<{ id: string; name: string; sentence: string }>> {
  // Uncapped: which ones moved is decided after the read, so a cap here could drop one that
  // did. A store has a handful of campaigns still ahead of it, not thousands.
  const rows = await prisma.campaign.findMany({
    where: {
      shopId,
      status: { in: [...OPEN] },
      OR: [{ startAt: { gt: now } }, { endAt: { gt: now } }],
    },
    orderBy: { startAt: "asc" },
    select: { id: true, name: true, status: true, schedule: true },
  });

  return rows.flatMap((row) => {
    const shift = zoneShiftOf(parseSchedule(row.schedule), row.status, storeZone, now);
    return shift ? [{ id: row.id, name: row.name, sentence: describeZoneShift(shift) }] : [];
  });
}

async function campaignOf(shopId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { id: true, name: true, status: true, schedule: true, startAt: true, endAt: true },
  });
  if (!campaign) {
    throw new AppError({ code: "NOT_FOUND", userMessage: "That campaign no longer exists. Reload the page." });
  }
  return campaign;
}

const MOVED_UNDERNEATH =
  "changed while you were deciding, so its times were not changed. Reload the page to see where it is now.";

/**
 * Keep the times as the merchant set them: 09:00 typed in UTC becomes 09:00 on the store's
 * clock. The zone is asked of Shopify here, not taken from the page, because "the store's
 * clock" is whatever Shopify says it is now.
 */
export async function keepTypedTimes(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  actor: string,
): Promise<{ ok: boolean; message: string }> {
  const campaign = await campaignOf(shopId, campaignId);
  const zone = await confirmShopTimezone(shopId, client, actor);
  if (!zone) return { ok: false, message: unknownZoneMessage("Dates", "The times were not changed.") };

  const now = new Date();
  const schedule = parseSchedule(campaign.schedule);
  const shift = zoneShiftOf(schedule, campaign.status, zone, now);
  if (schedule.kind !== "window" || !shift) {
    return { ok: true, message: `"${campaign.name}" already runs at the times it was set for on your store's clock. Nothing was changed.` };
  }

  const kept = keptWallClock(schedule, shift);
  const startMoves = shift.moments.some((moment) => moment.which === "start");
  const problem = windowInputProblem({
    startUtc: kept.startUtc,
    endUtc: kept.endUtc,
    now,
    // A start moved into the past would start the sale on the next tick: that is Apply's
    // decision to make, not this button's. A live campaign's start has passed already.
    futureStart: startMoves,
    describe: (iso) => `${formatScheduleInstant(iso, zone)} (${zone})`,
  });
  if (problem) return { ok: false, message: `${problem} The times were not changed.` };

  const blob = { ...((campaign.schedule ?? {}) as Record<string, unknown>) };
  blob.startAt = kept.startUtc;
  if (kept.endUtc) blob.endAt = kept.endUtc;
  else delete blob.endAt;
  if (kept.clockNotes.length > 0) blob.clockNotes = kept.clockNotes;
  else delete blob.clockNotes;
  blob.zone = zone;

  const updated = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: campaign.status, startAt: campaign.startAt, endAt: campaign.endAt },
    data: {
      schedule: blob as never,
      startAt: new Date(kept.startUtc),
      endAt: kept.endUtc ? new Date(kept.endUtc) : null,
    },
  });
  if (updated.count === 0) return { ok: false, message: `"${campaign.name}" ${MOVED_UNDERNEATH}` };

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.reschedule",
      entity: "Campaign",
      entityId: campaignId,
      before: { startAt: campaign.startAt?.toISOString() ?? null, endAt: campaign.endAt?.toISOString() ?? null, zone: shift.from } as never,
      after: { startAt: kept.startUtc, endAt: kept.endUtc, zone, reason: "kept the times as set after the store's zone changed" } as never,
    },
  });

  const when = shift.moments
    .map((moment) => {
      const at = moment.which === "start" ? kept.startUtc : (kept.endUtc ?? moment.at);
      return `${moment.which === "start" ? "starts" : "ends"} ${formatScheduleInstant(at, zone)}`;
    })
    .join(" and ");
  return { ok: true, message: [`"${campaign.name}" ${when} (${zone}), as it was set.`, ...kept.clockNotes].join(" ") };
}

/**
 * Keep the times as they now read on the store's clock: nothing moves, and the campaign
 * records that its times are in the store's zone, so it is not raised again.
 *
 * `shownZone` is the zone the page showed the new times in. If the store's zone has moved
 * again since, the merchant agreed to something that is no longer on offer, so it is asked
 * again rather than recorded.
 */
export async function keepShownTimes(
  shopId: string,
  campaignId: string,
  shownZone: string,
  actor: string,
): Promise<{ ok: boolean; message: string }> {
  const campaign = await campaignOf(shopId, campaignId);
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { timezone: true } });
  const zone = shop?.timezone ?? "";
  if (!shownZone || shownZone !== zone) {
    return {
      ok: false,
      message: `Your store's time zone has changed again, to ${zone}, so "${campaign.name}" was not changed. Reload the page to see its times now.`,
    };
  }

  const schedule = parseSchedule(campaign.schedule);
  const shift = zoneShiftOf(schedule, campaign.status, zone, new Date());
  if (schedule.kind !== "window" || !shift) {
    return { ok: true, message: `"${campaign.name}" already runs at the times shown. Nothing was changed.` };
  }

  const updated = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: campaign.status, startAt: campaign.startAt, endAt: campaign.endAt },
    data: { schedule: { ...((campaign.schedule ?? {}) as Record<string, unknown>), zone } as never },
  });
  if (updated.count === 0) return { ok: false, message: `"${campaign.name}" ${MOVED_UNDERNEATH}` };

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.zone",
      entity: "Campaign",
      entityId: campaignId,
      before: { zone: shift.from } as never,
      after: { zone, reason: "kept the times as they read in the store's new zone" } as never,
    },
  });

  const when = shift.moments.map((moment) => `${moment.which === "start" ? "starts" : "ends"} ${moment.nowText}`).join(" and ");
  return { ok: true, message: `"${campaign.name}" keeps its new times: it ${when} (${zone}).` };
}
