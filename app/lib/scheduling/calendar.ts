/**
 * Laying campaigns out on a calendar, in the store's own days.
 *
 * A promo calendar is the feature merchants ask for by name — BulkPriceBoard proved the
 * demand and then collapsed to 2.1 stars on reliability — so the interesting part is not
 * drawing a grid. It is being right about two things a grid usually gets wrong.
 *
 * **Days are the store's, not the server's or the browser's.** A sale that starts at 9pm
 * on the 3rd in Los Angeles starts at 4am on the 4th in UTC, and a calendar that filed it
 * under the 4th would be telling a merchant in California that their sale runs on the
 * wrong day. Every bucket here is computed in the store's zone, and the zone is shown on
 * the page so it is never a silent assumption.
 *
 * **A campaign occupies every day it spans**, not only the day it starts. That is the
 * whole reason to look at a calendar: to see that next week's sale is still running when
 * the one after it begins.
 */

export interface CalendarCampaign {
  id: string;
  name: string;
  status: string;
  /** ISO 8601 UTC. Absent for a campaign with no schedule at all. */
  startAt?: string | null;
  /** ISO 8601 UTC. Absent means "runs until reverted by hand". */
  endAt?: string | null;
}

export interface CalendarEntry {
  campaignId: string;
  name: string;
  status: string;
  /** True on the day the campaign starts, so the grid can mark the leading edge. */
  starts: boolean;
  /** True on its last day. A campaign with no end never sets this. */
  ends: boolean;
  /** True when it runs past the end of the visible range rather than stopping there. */
  continues: boolean;
}

/**
 * A campaign occurrence that actually happened.
 *
 * A schedule says what is meant to happen; a run is what did. Both belong on the
 * calendar and they are not the same thing — a campaign scheduled for the 3rd that was
 * reclaimed as partial on the 4th is a merchant's whole question, and a calendar showing
 * only the intention cannot answer it.
 *
 * This is also what "every materialised occurrence" means for a campaign that runs more
 * than once: each run is one occurrence, on the day it happened.
 */
export interface CalendarRun {
  runId: string;
  campaignId: string;
  name: string;
  /** APPLY or REVERT. */
  kind: string;
  status: string;
}

export interface CalendarDay {
  /** `YYYY-MM-DD` in the store's zone. */
  date: string;
  /** Whether this day belongs to the month being viewed, or is grid padding. */
  inFocus: boolean;
  entries: CalendarEntry[];
  /** Runs that started on this day, in the store's zone. */
  runs: CalendarRun[];
}

/** The local calendar date of an instant, as `YYYY-MM-DD`. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives us the ordering
  // we want without reassembling parts by hand.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Adds days to a `YYYY-MM-DD` string without going near a timezone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Day of the week for a `YYYY-MM-DD` string, 0 = Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export interface CalendarRange {
  /** First day shown, `YYYY-MM-DD`. */
  from: string;
  /** Last day shown, inclusive. */
  to: string;
}

/**
 * The six-week grid a month view shows, padded to whole weeks.
 *
 * Padded because a month that started on a Saturday would otherwise render one campaign
 * on the first row and nothing else, hiding the sale that ran through the last week of
 * the previous month — which is exactly the collision a merchant opens a calendar to see.
 */
export function monthRange(year: number, month: number, weekStartsOn = 0): CalendarRange {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const lead = (weekdayOf(first) - weekStartsOn + 7) % 7;
  const trail = 6 - ((weekdayOf(last) - weekStartsOn + 7) % 7);

  return { from: addDays(first, -lead), to: addDays(last, trail) };
}

/** The week containing a given day. */
export function weekRange(date: string, weekStartsOn = 0): CalendarRange {
  const lead = (weekdayOf(date) - weekStartsOn + 7) % 7;
  const from = addDays(date, -lead);
  return { from, to: addDays(from, 6) };
}

/**
 * Places campaigns onto days.
 *
 * A campaign with no start is left out entirely rather than filed under today. A manual
 * campaign has no date; putting it on one would be an invention, and the merchant would
 * reasonably read it as scheduled.
 */
export function layOut(
  campaigns: readonly CalendarCampaign[],
  range: CalendarRange,
  timeZone: string,
  focusMonth?: { year: number; month: number },
  runs: readonly (CalendarRun & { startedAt: string })[] = [],
): CalendarDay[] {
  const days: CalendarDay[] = [];

  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    const inFocus = focusMonth
      ? date.startsWith(`${focusMonth.year}-${String(focusMonth.month).padStart(2, "0")}`)
      : true;
    days.push({ date, inFocus, entries: [], runs: [] });
  }

  const byDate = new Map(days.map((day) => [day.date, day]));

  for (const run of runs) {
    const day = byDate.get(localDate(new Date(run.startedAt), timeZone));
    if (!day) continue;
    day.runs.push({
      runId: run.runId,
      campaignId: run.campaignId,
      name: run.name,
      kind: run.kind,
      status: run.status,
    });
  }

  for (const campaign of campaigns) {
    if (!campaign.startAt) continue;

    const start = localDate(new Date(campaign.startAt), timeZone);
    // No end means it runs until somebody reverts it, so it occupies every remaining
    // day of the view rather than a single square.
    const end = campaign.endAt ? localDate(new Date(campaign.endAt), timeZone) : range.to;

    // Entirely outside the visible range.
    if (end < range.from || start > range.to) continue;

    for (const day of days) {
      if (day.date < start || day.date > end) continue;

      day.entries.push({
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        starts: day.date === start,
        ends: Boolean(campaign.endAt) && day.date === end,
        continues: !campaign.endAt && day.date === range.to,
      });
    }
  }

  return days;
}

export interface OverlapPair {
  a: string;
  b: string;
}

/**
 * Campaign pairs whose windows touch.
 *
 * Time overlap only — sharing a day says nothing about sharing a product, and the
 * expensive question of whether their scopes intersect is answered separately against
 * the catalogue. Narrowing by time first is what keeps that affordable: a store with
 * forty campaigns has 780 pairs, and usually a handful that are ever live together.
 *
 * Half-open on the end, so a campaign ending at midnight on the 5th does not "overlap"
 * one starting at that same instant. They are consecutive, which is what a merchant
 * scheduling back-to-back sales intends, and flagging it would make the badge meaningless
 * by making it constant.
 */
export function timeOverlaps(campaigns: readonly CalendarCampaign[]): OverlapPair[] {
  const dated = campaigns.filter((campaign) => campaign.startAt);
  const pairs: OverlapPair[] = [];

  for (let i = 0; i < dated.length; i += 1) {
    for (let j = i + 1; j < dated.length; j += 1) {
      const first = dated[i];
      const second = dated[j];

      const aStart = Date.parse(first.startAt!);
      const bStart = Date.parse(second.startAt!);
      const aEnd = first.endAt ? Date.parse(first.endAt) : Number.POSITIVE_INFINITY;
      const bEnd = second.endAt ? Date.parse(second.endAt) : Number.POSITIVE_INFINITY;

      if (aStart < bEnd && bStart < aEnd) {
        pairs.push({ a: first.id, b: second.id });
      }
    }
  }

  return pairs;
}
