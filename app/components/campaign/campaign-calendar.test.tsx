/**
 * The calendar card around the grid (#979).
 *
 * Two of #979's four failures were here rather than in the grid. The calendar drew
 * archived campaigns that the list it was switched from hides, and the overlap card said
 * two campaigns "run together" when both had finished months ago.
 *
 * Which campaigns come back is the service's job, and `calendar-archive-runs.chaos.ts`
 * asks it of a real database. What this asks is that the card says which set it is
 * showing and keeps showing it: every link here used to be built without the list's
 * filter, so one click on Next would swap the archived campaigns for the active ones.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignCalendar, overlapSentence, type CampaignCalendarProps } from "./CampaignCalendar";
import type { Overlap } from "../../services/calendar.server";

const props = (over: Partial<CampaignCalendarProps> = {}): CampaignCalendarProps => ({
  days: [],
  overlaps: [],
  timeZone: "Europe/London",
  from: "2026-09-27",
  to: "2026-10-31",
  period: "month",
  on: "2026-10-14",
  previous: "2026-09-01",
  next: "2026-11-01",
  today: "2026-10-14",
  heading: "October 2026",
  archived: false,
  ...over,
});

const render = (over: Partial<CampaignCalendarProps> = {}) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns?view=calendar">
      <CampaignCalendar {...props(over)} />
    </StaticRouter>,
  );

/** Every link to another view of the calendar, by what it says. */
const calendarLinks = (html: string) =>
  [...html.matchAll(/<(a|s-button|s-link)\b[^>]*href="([^"]*view=calendar[^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)].map(
    ([, , href, inner]) => ({ href: href.replace(/&amp;/g, "&"), text: inner.replace(/<[^>]+>/g, "").trim() }),
  );

describe("the list's archive filter", () => {
  it("is left off every link while it is off, and nothing says otherwise", () => {
    const html = render();
    const links = calendarLinks(html);

    expect(links.map((link) => link.text)).toEqual(["Month", "Week", "Previous", "Today", "Next"]);
    expect(links.filter((link) => link.href.includes("archived"))).toEqual([]);
    expect(html).not.toContain("archived campaigns only");
  });

  it("is said when it is on, and kept by every way of moving through the calendar", () => {
    const html = render({ archived: true });
    const links = calendarLinks(html);

    expect(html).toContain("Showing archived campaigns only");
    for (const text of ["Month", "Week", "Previous", "Today", "Next"]) {
      expect(links.find((link) => link.text === text)?.href, text).toMatch(/&archived=1$/);
    }
  });

  it("offers the way back to the active campaigns on the same period", () => {
    const back = calendarLinks(render({ archived: true })).find((link) => link.text === "Show active campaigns");
    expect(back?.href).toBe("/app/campaigns?view=calendar&period=month&on=2026-10-14");
  });
});

describe("the overlap card's tense", () => {
  const overlap = (aFinished: boolean, bFinished: boolean, sharedVariants = 3): Overlap => ({
    a: { id: "a", name: "Spring sale", finished: aFinished },
    b: { id: "b", name: "Clearance", finished: bFinished },
    sharedVariants,
  });

  it("puts two campaigns that have both finished in the past", () => {
    expect(overlapSentence(overlap(true, true))).toBe("ran together and shared 3 products.");
    expect(overlapSentence(overlap(true, true, 0))).toBe("ran together, but had no products in common.");
  });

  it("keeps the present while either is still on or still to come", () => {
    expect(overlapSentence(overlap(true, false))).toBe("run together and share 3 products.");
    expect(overlapSentence(overlap(false, true, 1))).toBe("run together and share 1 product.");
    expect(overlapSentence(overlap(false, false, 0))).toBe("run together, but have no products in common.");
  });

  it("writes the sentence on the card after both names", () => {
    const html = render({ overlaps: [overlap(true, true)] });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("Spring sale and Clearance ran together and shared 3 products.");
  });
});
