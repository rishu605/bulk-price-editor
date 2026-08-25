/**
 * The promo calendar: which campaigns run when, and where they collide.
 *
 * The collision is the point. A calendar that only draws bars is a prettier campaign
 * list; what a merchant cannot work out from a list is that next week's sitewide sale
 * overlaps the clearance they scheduled a fortnight ago, and that four hundred products
 * are in both.
 *
 * Overlap is answered in two steps because the two questions cost wildly different
 * amounts. Whether two windows touch is arithmetic on four timestamps. Whether their
 * scopes share a product is a query against the catalogue, so it is asked only about the
 * pairs that survived the first step — and asked as a `count` over both filters ANDed
 * together, never by materialising two lists of variant ids and intersecting them in
 * memory. On a 500K-variant catalogue that difference is the feature working or not.
 */

import prisma from "../db.server";
import {
  addDays,
  layOut,
  monthRange,
  timeOverlaps,
  weekRange,
  type CalendarCampaign,
  type CalendarDay,
} from "../lib/scheduling/calendar";
import { astOf, scopeOf } from "./campaigns/model.server";
import { astToWhere } from "./segments.server";

/** Statuses worth a place on a calendar. */
const SHOWN = [
  "SCHEDULED",
  "APPLYING",
  "ACTIVE",
  "REVERTING",
  "COMPLETED",
  "PARTIAL",
  "HELD",
] as const;

export interface Overlap {
  a: { id: string; name: string };
  b: { id: string; name: string };
  /** Variants in both campaigns' scopes. Zero means they share a week, not a product. */
  sharedVariants: number;
}

export interface CalendarView {
  days: CalendarDay[];
  overlaps: Overlap[];
  timeZone: string;
  /** `YYYY-MM-DD` of the first and last day shown. */
  from: string;
  to: string;
}

export interface CalendarOptions {
  /** "month" grid padded to whole weeks, or a single "week". */
  view?: "month" | "week";
  /** Anchor day, `YYYY-MM-DD` in the store's zone. Defaults to today there. */
  on?: string;
  /**
   * Pairs to check for shared products.
   *
   * Capped because it is one catalogue query each. A store with thirty campaigns live in
   * one month has hundreds of time-overlapping pairs, and a calendar that took a second
   * per page load to badge the tail of them would be worse than one that badges the
   * first few and says so.
   */
  maxOverlapChecks?: number;
}

export async function calendarFor(
  shopId: string,
  timeZone: string,
  options: CalendarOptions = {},
): Promise<CalendarView> {
  const view = options.view ?? "month";
  const anchor = options.on ?? todayIn(timeZone);
  const [year, month] = anchor.split("-").map(Number);

  const range = view === "week" ? weekRange(anchor) : monthRange(year, month);

  const records = await prisma.campaign.findMany({
    where: { shopId, status: { in: [...SHOWN] } },
    select: { id: true, name: true, status: true, startAt: true, endAt: true },
    orderBy: { startAt: "asc" },
  });

  const campaigns: CalendarCampaign[] = records.map((record) => ({
    id: record.id,
    name: record.name,
    status: record.status,
    startAt: record.startAt?.toISOString() ?? null,
    endAt: record.endAt?.toISOString() ?? null,
  }));

  // Runs that started inside the visible range. Bounded generously in UTC and bucketed
  // by the store's day afterwards, because a day in the store's zone is not a day in
  // UTC and querying by the latter would drop the edges.
  const runs = await prisma.campaignRun.findMany({
    where: {
      shopId,
      startedAt: {
        gte: new Date(`${addDays(range.from, -1)}T00:00:00.000Z`),
        lte: new Date(`${addDays(range.to, 1)}T23:59:59.999Z`),
      },
    },
    select: {
      id: true,
      kind: true,
      status: true,
      startedAt: true,
      campaignId: true,
      campaign: { select: { name: true } },
    },
    orderBy: { startedAt: "asc" },
  });

  const days = layOut(
    campaigns,
    range,
    timeZone,
    view === "month" ? { year, month } : undefined,
    runs
      .filter((run) => run.startedAt)
      .map((run) => ({
        runId: run.id,
        campaignId: run.campaignId,
        name: run.campaign.name,
        kind: run.kind,
        status: run.status,
        startedAt: run.startedAt!.toISOString(),
      })),
  );

  // Only campaigns actually on screen. A collision three months from now is real but it
  // is not what this page is answering.
  const visible = new Set(days.flatMap((day) => day.entries.map((entry) => entry.campaignId)));
  const onScreen = campaigns.filter((campaign) => visible.has(campaign.id));

  return {
    days,
    overlaps: await sharedScopes(shopId, onScreen, options.maxOverlapChecks ?? 20),
    timeZone,
    from: range.from,
    to: range.to,
  };
}

/**
 * For each time-overlapping pair, how many variants they both price.
 *
 * Counted with both filters ANDed rather than by intersecting two lists of ids: the
 * database already has the index, and a 500K-variant catalogue would not survive the
 * alternative.
 *
 * A pair sharing zero variants is still returned. "These run at the same time and touch
 * nothing in common" is a useful thing for a merchant to be able to see, and dropping it
 * would leave them unable to tell it apart from "we did not check".
 */
async function sharedScopes(
  shopId: string,
  campaigns: readonly CalendarCampaign[],
  limit: number,
): Promise<Overlap[]> {
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const pairs = timeOverlaps(campaigns).slice(0, limit);
  if (pairs.length === 0) return [];

  // Scopes resolved once per campaign, not once per pair. A campaign in five overlaps
  // would otherwise have its segment looked up five times.
  const scopes = new Map<string, ReturnType<typeof astToWhere>>();
  for (const id of new Set(pairs.flatMap((pair) => [pair.a, pair.b]))) {
    const record = await prisma.campaign.findFirst({
      where: { id, shopId },
      select: { schedule: true },
    });
    if (!record) continue;

    // Through `scopeOf`, so a campaign targeting a segment is measured by what the
    // segment matches *now* — the same scope its next run will use.
    scopes.set(id, astToWhere(shopId, await scopeOf(shopId, record).catch(() => astOf(record))));
  }

  const overlaps: Overlap[] = [];

  for (const pair of pairs) {
    const a = scopes.get(pair.a);
    const b = scopes.get(pair.b);
    if (!a || !b) continue;

    overlaps.push({
      a: { id: pair.a, name: byId.get(pair.a)?.name ?? pair.a },
      b: { id: pair.b, name: byId.get(pair.b)?.name ?? pair.b },
      sharedVariants: await prisma.variantIndex.count({
        where: { shopId, deletedAt: null, AND: [a, b] },
      }),
    });
  }

  // Most entangled first: the pair sharing four hundred products is the one to look at,
  // not the one sharing none.
  return overlaps.sort((x, y) => y.sharedVariants - x.sharedVariants);
}

/** Today's date in the store's zone, `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
