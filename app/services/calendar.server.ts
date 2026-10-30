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
  placeCampaign,
  timeOverlaps,
  weekRange,
  type CalendarCampaign,
  type CalendarDay,
  type CampaignRunFact,
} from "../lib/scheduling/calendar";
import { lifecycleBadge } from "../lib/campaigns/lifecycle-of";
import { campaignFilterWhere, type StatusFilter } from "../lib/campaigns/list-filters";
import { PRICING_STATES, type CampaignState } from "../lib/lifecycle/transitions";
import { overlapEnded, type Overlap, type OverlapSide } from "../lib/scheduling/overlap-card";
import { astOf, DEFINITION, endingAmong, scopeOf } from "./campaigns/model.server";
import { astToWhere } from "./segments.server";

/**
 * Statuses worth a place on a calendar.
 *
 * Completed among them, as history: drawn on the days it ran and no others (#768). It
 * used to be drawn from its schedule, so one reverted by hand with no end ran on into
 * every future month.
 */
const SHOWN = [
  "SCHEDULED",
  "APPLYING",
  "ACTIVE",
  "REVERTING",
  "COMPLETED",
  "PARTIAL",
  "HELD",
] as const;

/**
 * A pair on the calendar at once, said so the card can put one that has ended in the past
 * tense (#979, #1016) and link only to a page that compares them. See `overlap-card.ts`.
 */
export type { Overlap, OverlapSide };

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
  /**
   * The campaigns list's archive filter (#979): archived campaigns only when it is on,
   * and none when it is off.
   *
   * The calendar drew every campaign in the shop, so one filed away showed up here and
   * nowhere in the list it was switched from. The where clause is the list's own, so the
   * two views of the index cannot disagree about which campaigns there are.
   */
  archived?: boolean;
  /**
   * The list's search and status filter (#1016), read the same way. The calendar took
   * the archive alone, so a merchant who filtered to "Needs a decision" and switched views
   * saw every campaign in the shop.
   */
  q?: string;
  status?: StatusFilter;
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
  // The list's own clause, ANDed with the statuses a calendar draws: a status filter for
  // one it does not, Draft, is a calendar with nothing on it, as the list would say.
  const filtered = campaignFilterWhere({
    q: options.q ?? "",
    status: options.status ?? "",
    archived: options.archived ?? false,
  });

  const records = await prisma.campaign.findMany({
    where: { shopId, AND: [{ status: { in: [...SHOWN] } }, filtered] },
    select: { id: true, name: true, status: true, startAt: true, endAt: true, schedule: true },
  });

  // What each campaign that has gone live actually did, so it is drawn where it ran rather
  // than where its schedule -- if it has one -- said it would (#768). A scheduled campaign
  // is drawn from its schedule alone, so its runs are not read.
  //
  // Whole-campaign runs only, as `endingAmong` reads them: one variant's revert out of a
  // running sale does not end the sale.
  const history = await prisma.campaignRun.findMany({
    where: {
      shopId,
      campaignId: {
        in: records.filter((record) => record.status !== "SCHEDULED").map((record) => record.id),
      },
      kind: { in: ["APPLY", "REVERT"] },
      startedAt: { not: null },
      NOT: { occurrenceKey: { startsWith: "VARIANT-" } },
    },
    select: { campaignId: true, kind: true, status: true, startedAt: true, finishedAt: true },
    orderBy: { createdAt: "asc" },
  });

  const historyOf = new Map<string, CampaignRunFact[]>();
  for (const run of history) {
    const facts = historyOf.get(run.campaignId) ?? [];
    facts.push({
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt!.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    });
    historyOf.set(run.campaignId, facts);
  }

  const now = new Date().toISOString();
  const campaigns: CalendarCampaign[] = records
    .map((record) =>
      placeCampaign(
        {
          id: record.id,
          name: record.name,
          status: record.status,
          // As the campaigns list labels it, ending or starting late included (#1056).
          lifecycle: lifecycleBadge(record.status as CampaignState, record.schedule, new Date(now)),
          startAt: record.startAt?.toISOString() ?? null,
          endAt: record.endAt?.toISOString() ?? null,
        },
        historyOf.get(record.id) ?? [],
        now,
      ),
    )
    // By where each is drawn, so a day's chips stack in the order their campaigns began
    // and keep that order from one day to the next: the dots after a row's first name
    // only read as "the same campaign" if they stay in the same place. Sorted here rather
    // than by the query, because a sale applied by hand has no `startAt` to order by.
    .sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? "") || a.id.localeCompare(b.id));

  // Runs that started inside the visible range. Bounded generously in UTC and bucketed
  // by the store's day afterwards, because a day in the store's zone is not a day in
  // UTC and querying by the latter would drop the edges.
  //
  // Scoped runs too, a reassert or an enrolment: they did happen that day. The occurrence
  // key is read so each is described as what it was rather than as an apply (#979). Under
  // the same filters as the campaigns (#979, #1016), or a campaign left off would still be
  // named under the days it ran.
  const runs = await prisma.campaignRun.findMany({
    where: {
      shopId,
      startedAt: {
        gte: new Date(`${addDays(range.from, -1)}T00:00:00.000Z`),
        lte: new Date(`${addDays(range.to, 1)}T23:59:59.999Z`),
      },
      campaign: filtered,
    },
    select: {
      id: true,
      kind: true,
      status: true,
      startedAt: true,
      occurrenceKey: true,
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
        occurrenceKey: run.occurrenceKey,
      })),
  );

  // Only campaigns actually on screen. A collision three months from now is real but it
  // is not what this page is answering.
  const visible = new Set(days.flatMap((day) => day.entries.map((entry) => entry.campaignId)));
  const onScreen = campaigns.filter((campaign) => visible.has(campaign.id));

  return {
    days,
    overlaps: await sharedScopes(shopId, onScreen, options.maxOverlapChecks ?? 20, now),
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
 *
 * The count is each campaign's scope *now*, past overlaps included: no record says what a
 * segment matched while two campaigns that have ended ran together.
 */
async function sharedScopes(
  shopId: string,
  campaigns: readonly CalendarCampaign[],
  limit: number,
  now: string,
): Promise<Overlap[]> {
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const pairs = timeOverlaps(campaigns).slice(0, limit);
  if (pairs.length === 0) return [];

  // Which of them are being ended, as `competingCampaigns` reads it: a campaign whose
  // latest whole run is a revert prices nothing another campaign is planned against.
  const ending = await endingAmong([...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))]);

  // Scopes resolved once per campaign, not once per pair. A campaign in five overlaps
  // would otherwise have its segment looked up five times.
  const scopes = new Map<string, ReturnType<typeof astToWhere>>();
  for (const id of new Set(pairs.flatMap((pair) => [pair.a, pair.b]))) {
    const record = await prisma.campaign.findFirst({
      where: { id, shopId },
      select: DEFINITION,
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

    const side = (id: string): OverlapSide => {
      const status = byId.get(id)?.status ?? "";
      return {
        id,
        name: byId.get(id)?.name ?? id,
        pricing: PRICING_STATES.has(status as CampaignState) && !ending.has(id),
        scheduled: status === "SCHEDULED",
      };
    };

    overlaps.push({
      a: side(pair.a),
      b: side(pair.b),
      sharedVariants: await prisma.variantIndex.count({
        where: { shopId, deletedAt: null, AND: [a, b] },
      }),
      // By the windows drawn, so a pair is history once the first of them closed (#1016).
      ended: overlapEnded(byId.get(pair.a) ?? {}, byId.get(pair.b) ?? {}, now),
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
