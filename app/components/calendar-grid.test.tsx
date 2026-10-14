/**
 * What the calendar grid writes in each square (#768).
 *
 * Two of the issue's failures were in the words, not the layout: after its first day a
 * running sale was an unlabelled dot, so a month after the one it started in was rows of
 * identical dots; and a busy day was a column of "applied" and "reverted" with no way to
 * tell whose was whose short of clicking each. The layout tests say which days carry the
 * name; these say the grid actually writes it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CalendarGrid } from "./CalendarGrid";
import { layOut, monthRange } from "../lib/scheduling/calendar";

// October 2026's grid: Sunday 27 Sep to Saturday 31 Oct.
const october = monthRange(2026, 10);

const render = (days: ReturnType<typeof layOut>) =>
  renderToStaticMarkup(<CalendarGrid days={days} today="2026-10-14" />);

/** The text of each badge, in order. */
const badges = (html: string) => [...html.matchAll(/<s-badge[^>]*>([^<]*)<\/s-badge>/g)].map((match) => match[1]);

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

  it("names it on every square for a screen reader", () => {
    // The dot's meaning is positional, which a screen reader cannot see.
    expect(html.match(/accessibilitylabel="Sale · 21\/09\/2026"/gi)).toHaveLength(35);
  });
});

describe("runs on a day", () => {
  const days = layOut([], october, "UTC", { year: 2026, month: 10 }, [
    { runId: "r1", campaignId: "a", name: "Autumn sale", kind: "APPLY", status: "COMPLETED", startedAt: "2026-10-14T09:00:00.000Z" },
    { runId: "r2", campaignId: "b", name: "QA · end before start", kind: "REVERT", status: "PARTIAL", startedAt: "2026-10-14T10:00:00.000Z" },
  ]);
  const html = render(days);

  it("names the campaign each run belongs to", () => {
    expect(html).toContain(">Applied Autumn sale<");
  });

  it("puts a run's state in brackets, apart from a name that has its own dots", () => {
    expect(html).toContain(">Reverted QA · end before start (partial)<");
  });
});
