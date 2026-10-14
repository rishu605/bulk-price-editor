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
 *
 * **A campaign that has run is drawn where it ran** (#768). The schedule is what was
 * meant to happen, and for a campaign that has gone live it is the weaker of the two
 * facts: a sale applied by hand has no schedule at all, and one reverted by hand stopped
 * whenever the merchant said so. `placeCampaign` decides which fact each campaign is drawn
 * from before anything here lays it out.
 */

import { PRICES_MAY_BE_LIVE, type CampaignState } from "../lifecycle/transitions";

export interface CalendarCampaign {
  id: string;
  name: string;
  status: string;
  /** ISO 8601 UTC. Absent for a campaign with nothing to place it on a day. */
  startAt?: string | null;
  /** ISO 8601 UTC. Absent means "runs until reverted by hand". */
  endAt?: string | null;
}

/**
 * One whole-campaign run, as much of it as placing the campaign needs (#768).
 *
 * Whole-campaign only: a run over named variants -- one variant's revert, an enrolment --
 * says nothing about whether the campaign as a whole is up, and the caller leaves those
 * out the way `endingAmong` does.
 */
export interface CampaignRunFact {
  /** APPLY or REVERT. Anything else is ignored. */
  kind: string;
  status: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** ISO 8601 UTC, once the run has stopped. */
  finishedAt?: string | null;
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
  /**
   * True where the grid writes the campaign's name: the day it starts, and the first day
   * of every week row it carries on into (#768).
   *
   * The name used to be on the starting day alone, so in any month after the one a sale
   * started in, it was a column of identical dots with nothing to say whose they were.
   * Naming every day would be the opposite failure -- a two-week sale as a wall of the
   * same words -- so the name opens each row and the dots after it read as "the same".
   */
  named: boolean;
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

/**
 * Whether a value from a URL is a day that exists, as `YYYY-MM-DD` (#747).
 *
 * The shape is not enough. `Date.UTC` rolls an impossible day forward rather than
 * refusing it, so `2026-02-31` became 3 March and `2026-13-45` became February of the
 * next year -- a page showing a different period from the one in its own heading, with
 * nothing to say so. A day only counts if it reads back as itself. Anything that does not
 * is treated as absent by the pages that take one, which fall back to their default.
 */
export function isCalendarDay(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
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

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The week view's heading: "Week of Sun 20 Sep 2026" (#768).
 *
 * It printed the anchor day as raw ISO -- "Week of 2026-09-25" above a grid starting on
 * Sunday the 20th -- so it named a day that was not the week's first, in a shape no other
 * date in the app uses. This names the first day the grid shows.
 *
 * The year stays, as the month heading's does: in a week view nothing else on the page
 * says which year it is, and Next walks into January without a word otherwise.
 *
 * Spelt out from fixed names rather than through `toLocaleDateString`, because the
 * locale data moves under it: en-GB's September became "Sept" in a recent ICU, with a
 * comma after the weekday, so the same call reads differently on two Node versions.
 */
export function weekHeading(date: string, weekStartsOn = 0): string {
  const first = weekRange(date, weekStartsOn).from;
  const [year, month, day] = first.split("-").map(Number);
  return `Week of ${WEEKDAY_NAMES[weekdayOf(first)]} ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * Where a campaign belongs on the calendar, from what it did as well as what it was meant
 * to do (#768).
 *
 * The calendar used to draw the schedule alone, which got the two campaigns a merchant
 * most needs to see exactly backwards. A sale applied by hand has no `startAt`, so the one
 * sale actually on the storefront was nowhere on the calendar -- nor in its overlap
 * count. And a campaign reverted by hand kept its `startAt` with no `endAt`, which reads
 * as "runs until reverted", so a finished sale filled every day of every future month.
 *
 * So the drawn window depends on the state:
 *
 * - **Prices may be live** (applying, active, held, partial, reverting): from the first
 *   apply of its current stretch, or the scheduled start if no run says otherwise. It
 *   ends at its scheduled end while that is still ahead, because that is when the
 *   scheduler takes it down. Otherwise it is open-ended: a sale whose end has passed and
 *   which is still up was *not* taken down, and runs until somebody does.
 *
 * - **Completed**: from that same first apply to the revert that finished it, and never
 *   past now. A completed campaign with nothing to say when it stopped is left off rather
 *   than given an end -- the only end anything could invent for it is "forever".
 *
 * - **Anything else** (scheduled): the schedule, which is the only fact there is.
 *
 * One stretch, the latest. A campaign reverted and applied again ran twice, and the gap
 * between is not a sale; drawing from its first-ever apply would fill that gap. The
 * earlier stretch is still on the calendar as the runs on the days they happened.
 *
 * Returns the campaign with `startAt` and `endAt` replaced by the window to draw, and
 * `startAt: null` when there is none -- which `layOut` leaves off.
 */
export function placeCampaign(
  campaign: CalendarCampaign,
  history: readonly CampaignRunFact[],
  now: string,
): CalendarCampaign {
  const status = campaign.status as CampaignState;
  const at = Date.parse(now);

  if (PRICES_MAY_BE_LIVE.has(status)) {
    const stretch = latestStretch(history);
    const ahead = campaign.endAt != null && Date.parse(campaign.endAt) > at;
    return {
      ...campaign,
      startAt: stretch?.from ?? campaign.startAt ?? null,
      endAt: ahead ? campaign.endAt : null,
    };
  }

  if (status === "COMPLETED") {
    const stretch = latestStretch(history);
    // An open stretch on a completed campaign is a run that stopped without a revert
    // finishing -- the campaign was completed some other way, such as its window closing
    // while it was still applying. No run says when it stopped, so it stops where its
    // schedule did, if that is behind us, and is left off if not.
    const from = stretch?.from ?? campaign.startAt ?? null;
    const scheduledEnd =
      campaign.endAt != null && Date.parse(campaign.endAt) <= at ? campaign.endAt : null;
    const to = stretch?.to ?? scheduledEnd;

    // Reverted before its scheduled start ("QA · end before start", applied and reverted
    // by hand days before the date it was set for) has no window at all on that date.
    if (!from || !to || Date.parse(to) < Date.parse(from)) {
      return { ...campaign, startAt: null, endAt: null };
    }
    return { ...campaign, startAt: from, endAt: to };
  }

  return campaign;
}

/**
 * The latest stretch a campaign's prices were up: from an apply to the revert that
 * finished it, or `to: null` while nothing has.
 *
 * An apply that failed or was cancelled wrote nothing, so it starts no stretch. Only a
 * *completed* revert ends one: a partial or failed revert left some of the campaign's
 * prices on the storefront, and a calendar that stopped drawing it there would be hiding
 * a sale that is still live.
 */
function latestStretch(
  history: readonly CampaignRunFact[],
): { from: string; to: string | null } | null {
  const ordered = [...history].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  let open: string | null = null;
  let closed: { from: string; to: string } | null = null;

  for (const run of ordered) {
    if (run.kind === "APPLY" && run.status !== "FAILED" && run.status !== "CANCELLED") {
      open ??= run.startedAt;
    } else if (run.kind === "REVERT" && run.status === "COMPLETED" && open !== null) {
      closed = { from: open, to: run.finishedAt ?? run.startedAt };
      open = null;
    }
  }

  return open !== null ? { from: open, to: null } : closed;
}

/**
 * Places campaigns onto days.
 *
 * A campaign with no start is left out entirely rather than filed under today. After
 * `placeCampaign`, that is one that has never gone live and has no date -- a manual
 * campaign nobody has applied, or a finished one with no known end. Putting either on a
 * day would be an invention, and the merchant would reasonably read it as scheduled.
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

    days.forEach((day, index) => {
      if (day.date < start || day.date > end) return;

      const starts = day.date === start;
      day.entries.push({
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        starts,
        ends: Boolean(campaign.endAt) && day.date === end,
        // Past the edge of the view whether it has no end or an end beyond it (#768). It
        // used to be only the former, so a sale ending next month showed a dot on the last
        // day here, which reads as "stops", rather than the arrow that says it does not.
        continues: day.date === range.to && (!campaign.endAt || end > range.to),
        // The grid lays the range out seven days to a row from its first day, so a day at
        // a multiple of seven from the start is the first square of a row.
        named: starts || index % 7 === 0,
      });
    });
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


/**
 * The datetime-local value a day on the calendar should pre-fill.
 *
 * Nine in the morning, not midnight. A sale that starts at midnight is a sale nobody
 * sees start, and a merchant clicking a Saturday means "that day", not "the first
 * instant of that day". They can still change it; this only decides what is already in
 * the box.
 *
 * Anything that is not a plain `YYYY-MM-DD` yields an empty field rather than a guess.
 * A malformed value in the URL is not worth turning into a date the merchant did not
 * choose and might not notice.
 */
export function presetStartFor(date: string | null | undefined, hour = "09:00"): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";

  // Rejects 2026-02-31 and 2026-13-01: they match the shape but are not days, and the
  // input would silently discard them anyway, leaving the field mysteriously blank.
  const [y, m, d] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) return "";

  return `${date}T${hour}`;
}
