/**
 * The campaigns index's filters, read by both of its views (#1016).
 *
 * The list honoured the status tabs and the search box; the calendar honoured only the
 * archive, and every link on it was built without the other two. So a merchant who
 * filtered to "Needs a decision", switched to the calendar, and pressed Next was looking
 * at every campaign in the shop -- and pressing List afterwards had forgotten the filter.
 *
 * One where clause and one way of writing a calendar link, so the two views cannot drift
 * apart again. `calendar-archive-runs.chaos.ts` asks the same of a real database.
 */

import { describe, expect, it } from "vitest";

import { calendarFilterNote, calendarHref, campaignFilterWhere, type ListFilters } from "./list-filters";

const NONE: ListFilters = { q: "", status: "", archived: false };

describe("the where clause both views read", () => {
  it("leaves archived campaigns off when nothing is set", () => {
    expect(campaignFilterWhere(NONE)).toEqual({ archivedAt: null });
  });

  it("shows only archived campaigns when the archive is asked for", () => {
    expect(campaignFilterWhere({ ...NONE, archived: true })).toEqual({ archivedAt: { not: null } });
  });

  it("searches the name and the note, in any case", () => {
    const contains = { contains: "spring", mode: "insensitive" };
    expect(campaignFilterWhere({ ...NONE, q: "spring" })).toEqual({
      archivedAt: null,
      OR: [{ name: contains }, { note: contains }],
    });
  });

  it("expands Needs a decision into the states that need one", () => {
    expect(campaignFilterWhere({ ...NONE, status: "attention" })).toEqual({
      archivedAt: null,
      status: { in: ["PARTIAL", "HELD"] },
    });
  });

  it("expands Live or scheduled into every state an archived campaign still runs in (#748)", () => {
    // Where the list's count of archived campaigns still running links: the prices that may
    // be live, and the starts still to come.
    expect(campaignFilterWhere({ ...NONE, status: "live", archived: true })).toEqual({
      archivedAt: { not: null },
      status: { in: ["APPLYING", "ACTIVE", "HELD", "REVERTING", "PARTIAL", "SCHEDULED"] },
    });
  });

  it("filters to one state", () => {
    expect(campaignFilterWhere({ ...NONE, status: "SCHEDULED" })).toEqual({ archivedAt: null, status: "SCHEDULED" });
  });
});

describe("a link to another view of the calendar", () => {
  const month = { period: "month" as const, on: "2026-10-14" };

  it("carries nothing it was not given", () => {
    expect(calendarHref(month, NONE)).toBe("/app/campaigns?view=calendar&period=month&on=2026-10-14");
  });

  it("keeps the status, the search and the archive, so List afterwards still has them", () => {
    const href = calendarHref({ period: "week", on: "2026-10-12" }, { q: "spring sale", status: "attention", archived: true });
    const params = new URL(href, "https://example.invalid").searchParams;

    expect(Object.fromEntries(params)).toEqual({
      view: "calendar",
      period: "week",
      on: "2026-10-12",
      status: "attention",
      q: "spring sale",
      archived: "1",
    });
  });

  it("encodes a search, so one with an ampersand in it stays one search", () => {
    const href = calendarHref(month, { ...NONE, q: "Bed & bath" });
    expect(new URL(href, "https://example.invalid").searchParams.get("q")).toBe("Bed & bath");
  });
});

describe("what the calendar says it is showing", () => {
  it("says nothing when no filter is set", () => {
    expect(calendarFilterNote(NONE)).toBeNull();
  });

  it("names the archive, and offers the active campaigns back", () => {
    expect(calendarFilterNote({ ...NONE, archived: true })).toEqual({
      text: "Showing only archived campaigns, as the list’s filter is set.",
      clear: { label: "Show active campaigns", filters: NONE },
    });
  });

  it("names a status filter the calendar would otherwise apply silently", () => {
    expect(calendarFilterNote({ ...NONE, status: "attention" })?.text).toBe(
      "Showing only campaigns that need a decision, as the list’s filter is set.",
    );
    expect(calendarFilterNote({ ...NONE, status: "live", archived: true })?.text).toBe(
      "Showing only archived live or scheduled campaigns, as the list’s filters are set.",
    );
    expect(calendarFilterNote({ ...NONE, status: "PARTIAL" })?.text).toBe(
      "Showing only partial campaigns, as the list’s filter is set.",
    );
  });

  it("names the search, and every filter together", () => {
    expect(calendarFilterNote({ ...NONE, q: "spring" })?.text).toBe(
      "Showing only campaigns matching “spring”, as the list’s filter is set.",
    );
    expect(calendarFilterNote({ q: "spring", status: "ACTIVE", archived: true })?.text).toBe(
      "Showing only archived active campaigns matching “spring”, as the list’s filters are set.",
    );
  });

  it("clears every filter at once when a status or search is set", () => {
    expect(calendarFilterNote({ q: "spring", status: "ACTIVE", archived: true })?.clear).toEqual({
      label: "Clear filters",
      filters: NONE,
    });
  });
});
