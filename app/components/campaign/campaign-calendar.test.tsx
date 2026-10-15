/**
 * The calendar card around the grid (#979, #1016).
 *
 * Two of #979's four failures were here rather than in the grid. The calendar drew
 * archived campaigns that the list it was switched from hides, and the overlap card said
 * two campaigns "run together" when both had finished months ago. #1016 was what #979
 * left: the list's status and search were dropped from every link, the card's heading
 * stayed in the present, and its one link could open a finished campaign.
 *
 * Which campaigns come back is the service's job, and `calendar-archive-runs.chaos.ts`
 * asks it of a real database. What this asks is that the card says which set it is
 * showing and keeps showing it: every link here used to be built without the list's
 * filters, so one click on Next would swap them for every campaign in the shop.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignCalendar, type CampaignCalendarProps } from "./CampaignCalendar";
import type { ListFilters } from "../../lib/campaigns/list-filters";
import type { Overlap, OverlapSide } from "../../lib/scheduling/overlap-card";

const NONE: ListFilters = { q: "", status: "", archived: false };

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
  filters: NONE,
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

const paramsOf = (href: string | undefined) => new URL(href ?? "", "https://example.invalid").searchParams;

const MOVES = ["Month", "Week", "Previous", "Today", "Next"];

describe("the list's archive filter", () => {
  it("is left off every link while it is off, and nothing says otherwise", () => {
    const html = render();
    const links = calendarLinks(html);

    expect(links.map((link) => link.text)).toEqual(MOVES);
    expect(links.filter((link) => /archived|status|q=/.test(link.href))).toEqual([]);
    expect(html).not.toContain("Showing only");
  });

  it("is said when it is on, and kept by every way of moving through the calendar", () => {
    const html = render({ filters: { ...NONE, archived: true } });
    const links = calendarLinks(html);

    expect(html).toContain("Showing only archived campaigns");
    for (const text of MOVES) {
      expect(links.find((link) => link.text === text)?.href, text).toMatch(/&archived=1$/);
    }
  });

  it("offers the way back to the active campaigns on the same period", () => {
    const back = calendarLinks(render({ filters: { ...NONE, archived: true } })).find(
      (link) => link.text === "Show active campaigns",
    );
    expect(back?.href).toBe("/app/campaigns?view=calendar&period=month&on=2026-10-14");
  });
});

describe("the list's status and search filters (#1016)", () => {
  const filters: ListFilters = { q: "spring", status: "attention", archived: false };

  it("are kept by every way of moving through the calendar, so List afterwards still has them", () => {
    const links = calendarLinks(render({ filters }));
    for (const text of MOVES) {
      const params = paramsOf(links.find((link) => link.text === text)?.href);
      expect(params.get("status"), text).toBe("attention");
      expect(params.get("q"), text).toBe("spring");
    }
  });

  it("are said, since the calendar has no tabs or search box to show them", () => {
    const text = render({ filters }).replace(/<[^>]+>/g, "");
    expect(text).toContain("Showing only campaigns that need a decision matching “spring”, as the list’s filters are set.");
  });

  it("can be cleared from the calendar, on the same period", () => {
    const clear = calendarLinks(render({ filters })).find((link) => link.text === "Clear filters");
    expect(clear?.href).toBe("/app/campaigns?view=calendar&period=month&on=2026-10-14");
  });
});

describe("the overlap card", () => {
  const side = (id: string, over: Partial<OverlapSide> = {}): OverlapSide => ({
    id,
    name: id === "a" ? "Spring sale" : "Clearance",
    pricing: false,
    scheduled: false,
    ...over,
  });
  const overlap = (over: Partial<Overlap> = {}): Overlap => ({
    a: side("a"),
    b: side("b"),
    sharedVariants: 3,
    ended: false,
    ...over,
  });
  const textOf = (html: string) => html.replace(/<[^>]+>/g, "");
  const priceButton = (html: string) =>
    /<s-button[^>]*href="([^"]*)"[^>]*>See which price each product gets<\/s-button>/.exec(html)?.[1];

  it("writes the sentence on the card after both names, in the past once the overlap has ended", () => {
    const html = render({ overlaps: [overlap({ ended: true })] });
    expect(textOf(html)).toContain("Spring sale and Clearance ran together and shared 3 products.");
  });

  it("is headed in the past when every overlap on it has ended, and offers no price link (#1016)", () => {
    const html = render({
      overlaps: [overlap({ ended: true, a: side("a", { pricing: true }), b: side("b", { pricing: true }) })],
    });
    expect(html).toContain('heading="Campaigns that ran at the same time"');
    expect(html).not.toContain("Campaigns running at the same time");
    expect(priceButton(html)).toBeUndefined();
  });

  it("stays in the present while an overlap goes on, and links to a campaign still pricing", () => {
    const html = render({ overlaps: [overlap({ a: side("a", { pricing: true }), b: side("b", { pricing: true }) })] });
    expect(html).toContain('heading="Campaigns running at the same time"');
    expect(priceButton(html)).toBe("/app/campaigns/a?tab=preview");
  });

  it("never links a finished campaign, even when the first pair on the card shares the most", () => {
    // The first pair, both finished, is what the button used to open.
    const html = render({
      overlaps: [
        overlap({ ended: true, sharedVariants: 40 }),
        overlap({ a: side("c", { scheduled: true }), b: side("d", { pricing: true }), sharedVariants: 2 }),
      ],
    });
    expect(priceButton(html)).toBe("/app/campaigns/c?tab=preview");
  });
});
