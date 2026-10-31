/**
 * What archiving a campaign leaves running, said before it is archived (#748).
 *
 * "Sale · 21/09/2026", Active, was archived from the overflow in one click, with nothing
 * said: its prices stayed live while it left the list. And a scheduled "Black Friday 2026"
 * archived in October still goes live on 27 Nov. These pin which presses ask first, that the
 * sentence names what keeps happening and when, in the store's zone, and that the three
 * places reading the states (the dialog, the list's count, the badge) read one set.
 */

import { describe, expect, it } from "vitest";

import { ALL_STATES, PRICES_MAY_BE_LIVE, type CampaignState } from "../lifecycle/transitions";
import { archivedTone, archiveWarning, RUNS_WHEN_ARCHIVED } from "./archive-warning";

const ZONE = "America/New_York";
const NOW = new Date("2026-10-31T12:00:00.000Z");
/** Black Friday 2026, 09:00 to 23:59 in New York. */
const WINDOW = { kind: "window", startAt: "2026-11-27T14:00:00.000Z", endAt: "2026-11-28T04:59:00.000Z" };
const MANUAL = { kind: "manual" };

const warn = (state: CampaignState, schedule: unknown = WINDOW, label = "Scheduled", practice = false) =>
  archiveWarning(state, schedule, ZONE, label, practice, NOW);

describe("which presses ask first", () => {
  it("asks for every state with prices that may be live, and for a scheduled one", () => {
    expect([...RUNS_WHEN_ARCHIVED].sort()).toEqual([...PRICES_MAY_BE_LIVE, "SCHEDULED"].sort());
    for (const state of RUNS_WHEN_ARCHIVED) expect(warn(state), state).not.toBeNull();
  });

  it.each(["DRAFT", "COMPLETED", "CANCELLED"] as const)("archives a %s campaign in one click, as before", (state) => {
    // Nothing live and nothing coming: a confirmation here would teach merchants to click
    // through the one that matters.
    expect(warn(state)).toBeNull();
    expect(ALL_STATES).toContain(state);
  });

  it("asks nothing for a practice campaign, which never writes a price", () => {
    expect(warn("SCHEDULED", WINDOW, "Scheduled", true)).toBeNull();
  });
});

describe("what it says keeps happening", () => {
  it("says a scheduled campaign still starts, on its date in the store's zone", () => {
    expect(warn("SCHEDULED")).toEqual({
      keeps: "It will still start 27 Nov 2026, 09:00 (America/New_York), and its prices go live then.",
      instead: "To stop it starting, close this and use Cancel or unschedule.",
    });
  });

  it("does not promise a start the badge says is in doubt", () => {
    // "Scheduled — will never start", "— couldn't start", "— needs confirming": still
    // scheduled, and no more than that is said.
    expect(warn("SCHEDULED", WINDOW, "Scheduled — will never start")?.keeps).toBe(
      "It is still scheduled to start 27 Nov 2026, 09:00 (America/New_York).",
    );
  });

  it("says an active campaign's prices stay live, and when the schedule still ends it", () => {
    const active = warn("ACTIVE", { ...WINDOW, startAt: "2026-10-30T13:00:00.000Z" });
    expect(active?.keeps).toBe(
      "Its prices stay live on your storefront. The schedule still reverts it 27 Nov 2026, 23:59 (America/New_York).",
    );
    expect(active?.instead).toBe("To take its prices down, revert it instead.");
  });

  it("says one with no end runs until it is reverted", () => {
    expect(warn("ACTIVE", MANUAL)?.keeps).toBe("Its prices stay live on your storefront. It runs until you revert it.");
    expect(warn("ACTIVE", { kind: "window", startAt: WINDOW.startAt })?.keeps).toMatch(/It runs until you revert it\.$/);
  });

  it("names no end that has already passed", () => {
    // The scheduler is already ending it, and the badge says so (#1005).
    const past = { kind: "window", startAt: "2026-10-01T13:00:00.000Z", endAt: "2026-10-30T13:00:00.000Z" };
    expect(warn("ACTIVE", past)?.keeps).toBe("Its prices stay live on your storefront.");
  });

  it("says what a held, partial, applying or reverting campaign keeps doing", () => {
    expect(warn("HELD", MANUAL)?.keeps).toMatch(/^Its prices stay live on your storefront, and the edits holding it still wait in the drift queue\./);
    expect(warn("PARTIAL", MANUAL)).toEqual({
      keeps: "Some of its prices stay live on your storefront, and its run stays stopped part way.",
      instead: "To finish it, resume it or revert it instead.",
    });
    expect(warn("APPLYING", MANUAL)).toEqual({
      keeps: "It is writing its prices to your storefront now, and they stay live. It runs until you revert it.",
      instead: "To take its prices down, revert it once it has finished.",
    });
    expect(warn("REVERTING", MANUAL)).toEqual({
      keeps: "It is taking its prices down now, and the ones it has not reached yet stay live until it finishes.",
      instead: null,
    });
  });
});

describe("the Archived badge", () => {
  it("is a warning on a campaign still running, and a tag on one that is done", () => {
    for (const state of ALL_STATES) {
      expect(archivedTone(state), state).toBe(RUNS_WHEN_ARCHIVED.has(state) ? "warning" : "neutral");
    }
    expect(archivedTone("ACTIVE")).toBe("warning");
    expect(archivedTone("SCHEDULED")).toBe("warning");
    expect(archivedTone("COMPLETED")).toBe("neutral");
  });
});
