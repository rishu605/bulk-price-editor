/**
 * The campaigns index's filters -- status, search and archive -- as both of its views read
 * them (#1016).
 *
 * The list and the calendar are two views of one set of campaigns. The calendar read the
 * archive alone and built its links without the other two, so a merchant who had filtered
 * to "Needs a decision" saw every campaign in the shop on the calendar, and lost the filter
 * on the way back to the list. One where clause and one link builder keep the views on the
 * same set.
 */

import { humanise } from "../format/label";
import type { CampaignState } from "../lifecycle/transitions";

/** What the status filter can be: everything, the ones needing a decision, or one state. */
export type StatusFilter = "" | "attention" | CampaignState;

/** The filters a view of the index is under. The list's paging is its own. */
export interface ListFilters {
  /** Matches the campaign's name or note. */
  q: string;
  status: StatusFilter;
  /** Archived campaigns only, rather than none. */
  archived: boolean;
}

/** The states `needsAttention` is true for, as the database sees them. */
export const ATTENTION_STATES: CampaignState[] = ["PARTIAL", "HELD"];

/** The filters as a Prisma `campaign` where clause, without the shop. */
export function campaignFilterWhere(filters: ListFilters) {
  const contains = { contains: filters.q, mode: "insensitive" as const };

  return {
    // Archived is the *filter*, not a second list: one view, one control, and the row
    // still says what state the campaign is in. `null` and "not null" rather than a
    // boolean column, so the archive can be read in the order things were filed.
    archivedAt: filters.archived ? { not: null } : null,
    // The note is searched alongside the name, which is the point of having one: "why did
    // we run this" is not a question a merchant can answer by remembering what they
    // called it. Prisma leaves a null note out of a `contains` match, so a shop with no
    // notes searches exactly as it did before.
    ...(filters.q ? { OR: [{ name: contains }, { note: contains }] } : {}),
    // "attention" is not a status — it is a property of several of them, so it is
    // expanded here rather than being a magic string the database has to understand.
    ...(filters.status === "attention"
      ? { status: { in: ATTENTION_STATES } }
      : filters.status
        ? { status: filters.status }
        : {}),
  };
}

/**
 * A link to the calendar at a period and day, under the filters it is showing.
 *
 * Every filter goes on every link, so moving through months keeps them, and the List
 * button -- built from the query string of the page it is on -- carries them back.
 */
export function calendarHref(
  target: { period: "week" | "month"; on: string },
  filters: ListFilters,
): string {
  const params = new URLSearchParams({ view: "calendar", period: target.period, on: target.on });
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.archived) params.set("archived", "1");
  return `/app/campaigns?${params}`;
}

const NONE: ListFilters = { q: "", status: "", archived: false };

/**
 * What the calendar says about the filters it is under, and the way out of them.
 *
 * Said, because the grid looks the same either way: a calendar of three campaigns that did
 * not say it was filtered would read as the shop's schedule (#979). The list shows its
 * filters as its tabs and its search box; the calendar has neither.
 */
export function calendarFilterNote(
  filters: ListFilters,
): { text: string; clear: { label: string; filters: ListFilters } } | null {
  const set = [filters.status, filters.q, filters.archived].filter(Boolean).length;
  if (set === 0) return null;

  const kind =
    filters.status === "attention"
      ? "campaigns that need a decision"
      : filters.status
        ? `${humanise(filters.status).toLowerCase()} campaigns`
        : "campaigns";
  const what = `${filters.archived ? "archived " : ""}${kind}${filters.q ? ` matching “${filters.q}”` : ""}`;

  return {
    text: `Showing only ${what}, as the list’s ${set === 1 ? "filter is" : "filters are"} set.`,
    // The archive alone has an opposite, which is what the merchant is likelier to want
    // than "everything". Anything else clears the lot, as the list's own Clear does.
    clear:
      set === 1 && filters.archived
        ? { label: "Show active campaigns", filters: NONE }
        : { label: "Clear filters", filters: NONE },
  };
}
