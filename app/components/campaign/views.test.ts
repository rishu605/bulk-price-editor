/**
 * List and calendar are one route, and the parameter that says which.
 *
 * The two were separate nav items showing the same objects, so a merchant asking "what
 * is running next week?" had to already know a calendar existed.
 *
 * The trap in merging them: the calendar already used `?view=` for week-or-month. One
 * parameter cannot mean both, so the calendar's own toggle moved to `?period=`. A stale
 * `?view=week` would otherwise read as "not calendar" and silently show the list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const route = readFileSync(
  join(process.cwd(), "app", "routes", "app.campaigns._index.tsx"),
  "utf8",
);
const calendar = readFileSync(
  join(process.cwd(), "app", "components", "campaign", "CampaignCalendar.tsx"),
  "utf8",
);
const stub = readFileSync(
  join(process.cwd(), "app", "routes", "app.campaigns.calendar.tsx"),
  "utf8",
);

describe("one parameter, one meaning", () => {
  it("uses view for list-or-calendar", () => {
    expect(route).toContain('params.get("view") === "calendar"');
  });

  it("uses period for week-or-month", () => {
    expect(route).toContain('params.get("period") === "week"');
  });

  it("no longer reads view as a calendar period anywhere", () => {
    for (const [name, source] of [["route", route], ["calendar", calendar]] as const) {
      expect(
        source.includes('view === "week"'),
        `${name} still treats view as a period, which now means something else`,
      ).toBe(false);
    }
  });

  it("carries a stale ?view=week across the redirect as ?period=week", () => {
    // The one link shape that would otherwise break: a bookmark of a specific week.
    expect(stub).toContain('to.set("period", period)');
  });
});

describe("both views read the same filters", () => {
  it("loads the list even when the calendar is showing", () => {
    // Switching views must not throw away the search or filter a merchant just set.
    const loaderBody = route.slice(route.indexOf("const list = await listCampaigns"));
    expect(loaderBody).toContain("listCampaigns(shop.id, filters)");
    expect(
      route.indexOf("const list = await listCampaigns") <
        route.indexOf('if (view === "list")'),
      "the list must load before the early return, or the calendar loses the filters",
    ).toBe(true);
  });
});

describe("the page header is a header, not a card", () => {
  it("puts the primary action in the tab bar's action slot", () => {
    // It used to sit in an `s-section` of its own above the tabs: a card holding one
    // button and a two-item toggle, mostly empty white space, which is the shape a page
    // takes when nobody has decided what its header is.
    expect(route).toMatch(/<TabBar[\s\S]*?action=\{[\s\S]*?Create campaign/);
  });

  it("does not wrap the tabs and the action in a card", () => {
    const header = route.slice(route.indexOf("<TabBar"), route.indexOf("/>", route.indexOf("tabs={")));
    expect(header).not.toContain("<s-section");
  });

  it("draws no card of its own at all", () => {
    // It used to draw one: the "How campaigns resolve" aside. That was prose explaining
    // the resolver rather than anything about this shop, so it is a `HelpNote` at the
    // foot of the page now and the route is down to a banner, a header and a view. The
    // list and the calendar bring their own cards.
    expect(route.split("<s-section").length - 1).toBe(0);
  });
});
