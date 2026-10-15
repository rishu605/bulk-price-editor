/**
 * What the calendar grid writes in each square (#768, #797, #979).
 *
 * Two of #768's failures were in the words, not the layout: after its first day a
 * running sale was an unlabelled dot, so a month after the one it started in was rows of
 * identical dots; and a busy day was a column of "applied" and "reverted" with no way to
 * tell whose was whose short of clicking each. The layout tests say which days carry the
 * name; these say the grid actually writes it.
 *
 * #797 was the same failure for a screen reader: day links named "5", campaign links
 * named "→" and "·", and status and "today" given only by colour and weight. #979 was the
 * run lines: every run "Applied", and one still writing painted red as if it had failed.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CalendarGrid } from "./CalendarGrid";
import { layOut, monthRange, type CalendarRunInput } from "../lib/scheduling/calendar";

// October 2026's grid: Sunday 27 Sep to Saturday 31 Oct.
const october = monthRange(2026, 10);

const render = (days: ReturnType<typeof layOut>) =>
  renderToStaticMarkup(<CalendarGrid days={days} today="2026-10-14" />);

/** The text of each badge, in order. */
const badges = (html: string) => [...html.matchAll(/<s-badge[^>]*>([^<]*)<\/s-badge>/g)].map((match) => match[1]);

/** Every link the grid draws: its href, its accessible name, and its visible text. */
const links = (html: string) =>
  [...html.matchAll(/<s-clickable([^>]*)>([\s\S]*?)<\/s-clickable>/g)].map(([, attrs, inner]) => {
    const label = /accessibilitylabel="([^"]*)"/i.exec(attrs)?.[1];
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return { href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "", name: label ?? text, text };
  });

/** React escapes `&` and quotes in attributes; the names here only need `&amp;` undone. */
const unescape = (value: string) => value.replace(/&amp;/g, "&");

describe("a running sale's name in a month after the one it started in", () => {
  const days = layOut(
    [{ id: "sale", name: "Sale · 21/09/2026", status: "ACTIVE", startAt: "2026-09-21T15:00:00.000Z", endAt: null }],
    october,
    "UTC",
    { year: 2026, month: 10 },
  );
  const html = render(days);

  it("opens every week row with the name, marked as a continuation", () => {
    const labels = badges(html);

    expect(labels).toHaveLength(35);
    expect(labels.filter((label) => label === "… Sale · 21/09/2026")).toHaveLength(5);
    expect(labels.filter((label) => label === "·")).toHaveLength(29);
    // Still running at the edge of the view.
    expect(labels.at(-1)).toBe("→");
  });

  it("names it on every square for a screen reader, with its status and which day of it this is", () => {
    // The dot's meaning is positional and its status is a colour, neither of which a
    // screen reader can see. Counted from the day it started in September, not from
    // the first square of October's grid.
    const entries = links(html).filter((link) => link.href === "/app/campaigns/sale");

    expect(entries).toHaveLength(35);
    expect(entries[0].name).toBe("Sale · 21/09/2026, active, day 7, no end date");
    expect(entries.at(-1)!.name).toBe("Sale · 21/09/2026, active, day 41, no end date");
    expect(entries.every((entry) => /^Sale · 21\/09\/2026, active, day \d+, no end date$/.test(entry.name))).toBe(true);
  });
});

describe("every link in the grid has a name that says where it goes (#797)", () => {
  const days = layOut(
    [
      {
        id: "bf",
        name: "Black Friday 2026",
        status: "SCHEDULED",
        startAt: "2026-10-12T09:00:00.000Z",
        endAt: "2026-10-16T21:00:00.000Z",
      },
    ],
    october,
    "UTC",
    { year: 2026, month: 10 },
    [{ runId: "r1", campaignId: "bf", name: "Black Friday 2026", kind: "APPLY", status: "COMPLETED", startedAt: "2026-10-14T09:00:00.000Z" }],
  );
  const html = render(days);
  const all = links(html);

  it("names a day by its weekday and full date, and says following it creates a campaign", () => {
    // It was named "5": no month, no weekday, and nothing to say what pressing it does.
    const day = all.find((link) => link.href === "/app/campaigns/new?startAt=2026-10-05")!;
    expect(day.name).toBe("Create a campaign starting Monday 5 Oct 2026");
    expect(day.text, "the square still shows only its number").toBe("5");
  });

  it("tells a padding day from this month's day of the same number", () => {
    const padding = all.find((link) => link.href === "/app/campaigns/new?startAt=2026-09-27")!;
    expect(padding.name).toBe("Create a campaign starting Sunday 27 Sep 2026");
  });

  it("says which day is today in words, not only with a fill and a bold weight", () => {
    const today = all.find((link) => link.href === "/app/campaigns/new?startAt=2026-10-14")!;
    expect(today.name).toBe("Create a campaign starting today, Wednesday 14 Oct 2026");
    expect(all.filter((link) => link.name.includes("today"))).toHaveLength(1);
  });

  it("names a campaign on every one of its days with its status and its place in it", () => {
    const entries = all.filter((link) => link.href === "/app/campaigns/bf").filter((link) => link.name !== link.text);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Black Friday 2026, scheduled, day 1 of 5",
      "Black Friday 2026, scheduled, day 2 of 5",
      "Black Friday 2026, scheduled, day 3 of 5",
      "Black Friday 2026, scheduled, day 4 of 5",
      "Black Friday 2026, scheduled, day 5 of 5",
    ]);
  });

  it("leaves no link named by a number, an arrow or a dot", () => {
    expect(all.length).toBeGreaterThan(35);
    const bare = all.filter((link) => /^[\d\s·→…]*$/.test(unescape(link.name)));
    expect(bare.map((link) => `${link.href}: "${link.name}"`)).toEqual([]);
  });
});

describe("runs on a day", () => {
  const run = (over: Partial<CalendarRunInput>): CalendarRunInput => ({
    runId: over.runId ?? "r",
    campaignId: "c",
    name: "Autumn sale",
    kind: "APPLY",
    status: "COMPLETED",
    startedAt: "2026-10-14T09:00:00.000Z",
    ...over,
  });
  const html = render(
    layOut([], october, "UTC", { year: 2026, month: 10 }, [
      run({ runId: "r1" }),
      run({ runId: "r2", campaignId: "b", name: "QA · end before start", kind: "REVERT", status: "PARTIAL" }),
    ]),
  );

  /** One run, rendered alone: its line and the tone it is drawn in. */
  const line = (over: Partial<CalendarRunInput>) => {
    const markup = render(layOut([], october, "UTC", { year: 2026, month: 10 }, [run(over)]));
    const match = /<s-text tone="([^"]*)">([^<]*)<\/s-text>/.exec(markup);
    return { tone: match?.[1], text: match?.[2] };
  };

  it("names the campaign each run belongs to", () => {
    expect(html).toContain(">Applied Autumn sale<");
  });

  it("puts a run's state in brackets, apart from a name that has its own dots", () => {
    expect(html).toContain(">Reverted QA · end before start (partial)<");
  });

  it("says whether a finished whole-campaign run applied or reverted it", () => {
    expect(line({ kind: "APPLY", status: "COMPLETED" })).toEqual({ tone: "success", text: "Applied Autumn sale" });
    expect(line({ kind: "REVERT", status: "COMPLETED" })).toEqual({ tone: "success", text: "Reverted Autumn sale" });
  });

  it("draws a run still writing as going, in a tone that is not a failure's (#979)", () => {
    // PLANNING and EXECUTING were critical, the red of a run that failed, and read
    // "Applied … (executing)".
    for (const status of ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"]) {
      const applying = line({ kind: "APPLY", status });
      expect(applying.text, status).toBe("Applying Autumn sale");
      expect(applying.tone, status).not.toBe("critical");
      expect(applying.tone, status).toBe("info");

      const reverting = line({ kind: "REVERT", status });
      expect(reverting.text, status).toBe("Reverting Autumn sale");
      expect(reverting.tone, status).toBe("info");
    }
  });

  it("keeps critical for a run that failed, and says so in words", () => {
    expect(line({ kind: "APPLY", status: "FAILED" })).toEqual({ tone: "critical", text: "Applied Autumn sale (failed)" });
  });

  it("never draws a run over named variants as the campaign being applied (#979)", () => {
    // Each of these is an APPLY or REVERT over a few variants, started under its own
    // `VARIANT-` occurrence key. Drawn as "Applied Autumn sale", each read as the whole
    // sale going live again on that day.
    const scoped = {
      "VARIANT-REASSERT-gid://shopify/ProductVariant/1-1760000000000": "Reasserted one price in Autumn sale",
      "VARIANT-ENROLL-1760000000000": "Enrolled new variants in Autumn sale",
      "VARIANT-REINSTATE-gid://shopify/ProductVariant/1-1760000000000": "Reinstated one variant in Autumn sale",
    };
    for (const [occurrenceKey, text] of Object.entries(scoped)) {
      expect(line({ kind: "APPLY", occurrenceKey }).text).toBe(text);
    }
    expect(
      line({ kind: "REVERT", occurrenceKey: "VARIANT-REVERT-gid://shopify/ProductVariant/1-1760000000000" }).text,
    ).toBe("Reverted one variant of Autumn sale");
    expect(line({ kind: "APPLY", occurrenceKey: "VARIANT-SOMETHING-NEW-1" }).text).toBe(
      "Repriced some variants in Autumn sale",
    );
  });

  it("names the older run kinds for what they did", () => {
    expect(line({ kind: "REASSERT" }).text).toBe("Reasserted one price in Autumn sale");
    expect(line({ kind: "ENROLL", status: "EXECUTING" }).text).toBe("Enrolling new variants in Autumn sale");
  });
});
