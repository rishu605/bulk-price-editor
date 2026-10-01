import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_REVERT_BUFFER_MINUTES,
  type SchedulableStatus,
  type Schedule,
  clockNote,
  describeSchedule,
  dueTransition,
  effectiveBufferMs,
  joinDateAndTime,
  localInputToUtc,
  parseSchedule,
  resolveLocalInput,
  scheduleWarnings,
  utcToLocalInput,
  windowClosed,
} from "./window";

const at = (iso: string) => new Date(iso);

const window = (over: Partial<Extract<Schedule, { kind: "window" }>> = {}): Schedule => ({
  kind: "window",
  startAt: "2026-08-20T09:00:00.000Z",
  endAt: "2026-08-22T09:00:00.000Z",
  revertBufferMinutes: 5,
  ...over,
});

describe("due transitions", () => {
  it("applies a scheduled campaign once its start has passed", () => {
    const state = { schedule: window(), status: "SCHEDULED" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-20T08:59:00Z"))).toBeNull();
    expect(dueTransition(state, at("2026-08-20T09:00:00Z"))).toBe("apply");
    expect(dueTransition(state, at("2026-08-20T09:01:00Z"))).toBe("apply");
  });

  it("catches up after a missed tick rather than dropping the campaign", () => {
    // The whole reason `due` is `at <= now` and not `at === now`: a deploy, restart
    // or slow queue must not silently skip a campaign whose moment fell in the gap.
    const state = { schedule: window(), status: "SCHEDULED" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-20T09:47:00Z"))).toBe("apply");
  });

  it("reverts early by the buffer, so prices are back before the window closes", () => {
    const state = { schedule: window(), status: "ACTIVE" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-22T08:54:00Z"))).toBeNull();
    expect(dueTransition(state, at("2026-08-22T08:55:00Z"))).toBe("revert");
  });

  it("reverts a partial run too — it may have left prices live", () => {
    const state = { schedule: window(), status: "PARTIAL" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-22T09:00:00Z"))).toBe("revert");
  });

  it("reverts a held campaign at its end — a price edit stops it writing, not its prices being live (#756)", () => {
    const state = { schedule: window(), status: "HELD" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-22T08:54:00Z"))).toBeNull();
    expect(dueTransition(state, at("2026-08-22T09:00:00Z"))).toBe("revert");
  });

  it("does not apply a campaign whose window has already closed", () => {
    // Created late, or resumed after an outage. Applying here would put a finished
    // sale live.
    const state = { schedule: window(), status: "SCHEDULED" as SchedulableStatus };
    expect(dueTransition(state, at("2026-09-01T00:00:00Z"))).toBeNull();
  });

  it("has nothing to revert for a campaign that never applied", () => {
    for (const status of ["DRAFT", "COMPLETED", "CANCELLED"] as SchedulableStatus[]) {
      expect(dueTransition({ schedule: window(), status }, at("2026-09-01T00:00:00Z")))
        .toBeNull();
    }
  });

  it("leaves an open-ended window running until reverted by hand", () => {
    const schedule = window({ endAt: undefined });
    expect(dueTransition({ schedule, status: "ACTIVE" }, at("2030-01-01T00:00:00Z")))
      .toBeNull();
    expect(windowClosed(schedule, at("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("never acts on a manual schedule", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(0), max: new Date(4102444800000) }), (now) => {
        expect(dueTransition({ schedule: { kind: "manual" }, status: "SCHEDULED" }, now))
          .toBeNull();
      }),
    );
  });

  it("returns at most one transition for any instant", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2026-08-19"), max: new Date("2026-08-23") }),
        fc.constantFrom<SchedulableStatus>("SCHEDULED", "ACTIVE", "PARTIAL", "HELD", "COMPLETED"),
        (now, status) => {
          const result = dueTransition({ schedule: window(), status }, now);
          expect(result === null || result === "apply" || result === "revert").toBe(true);
        },
      ),
    );
  });
});

describe("parseSchedule", () => {
  it("defaults to manual for anything it cannot act on", () => {
    expect(parseSchedule(undefined)).toEqual({ kind: "manual" });
    expect(parseSchedule({ kind: "window" })).toEqual({ kind: "manual" });
    expect(parseSchedule({ kind: "window", startAt: "not a date" })).toEqual({ kind: "manual" });
  });

  it("drops an unparseable end rather than inventing one", () => {
    const parsed = parseSchedule({
      kind: "window",
      startAt: "2026-08-20T09:00:00Z",
      endAt: "rubbish",
    });
    expect(parsed).toMatchObject({ kind: "window", endAt: undefined });
  });

  it("falls back to the default buffer for a missing or negative value", () => {
    const base = { kind: "window", startAt: "2026-08-20T09:00:00Z" };
    expect(parseSchedule(base)).toMatchObject({
      revertBufferMinutes: DEFAULT_REVERT_BUFFER_MINUTES,
    });
    expect(parseSchedule({ ...base, revertBufferMinutes: -5 })).toMatchObject({
      revertBufferMinutes: DEFAULT_REVERT_BUFFER_MINUTES,
    });
    expect(parseSchedule({ ...base, revertBufferMinutes: 0 })).toMatchObject({
      revertBufferMinutes: 0,
    });
  });
});

describe("timezone conversion", () => {
  it("reads a local input as the store's zone, not the viewer's", () => {
    // 09:00 in Toronto during EDT is 13:00 UTC.
    expect(localInputToUtc("2026-08-20T09:00", "America/Toronto"))
      .toBe("2026-08-20T13:00:00.000Z");
    // The same wall-clock time in Tokyo is a different instant entirely.
    expect(localInputToUtc("2026-08-20T09:00", "Asia/Tokyo"))
      .toBe("2026-08-20T00:00:00.000Z");
  });

  it("uses the offset in force on that date, so DST is handled", () => {
    // Toronto is UTC-5 in January and UTC-4 in August. A fixed offset would put one
    // of these an hour wrong.
    expect(localInputToUtc("2026-01-20T09:00", "America/Toronto"))
      .toBe("2026-01-20T14:00:00.000Z");
    expect(localInputToUtc("2026-08-20T09:00", "America/Toronto"))
      .toBe("2026-08-20T13:00:00.000Z");
  });

  it("round-trips through the store's zone", () => {
    for (const zone of ["America/Toronto", "Asia/Tokyo", "Europe/London", "UTC"]) {
      const utc = localInputToUtc("2026-08-20T14:30", zone)!;
      expect(utcToLocalInput(utc, zone)).toBe("2026-08-20T14:30");
    }
  });

  it("rejects malformed input rather than guessing", () => {
    expect(localInputToUtc("", "UTC")).toBeNull();
    expect(localInputToUtc("20/08/2026 9am", "UTC")).toBeNull();
  });

  it("renders midnight as 00:00, not 24:00", () => {
    const utc = localInputToUtc("2026-08-20T00:00", "Europe/London")!;
    expect(utcToLocalInput(utc, "Europe/London")).toBe("2026-08-20T00:00");
  });
});

describe("describeSchedule", () => {
  it("always names the zone", () => {
    const text = describeSchedule(window(), "America/Toronto");
    expect(text).toContain("America/Toronto");
    expect(text).toContain("Starts");
    expect(text).toContain("reverts");
  });

  it("says so when there is no end", () => {
    expect(describeSchedule(window({ endAt: undefined }), "UTC"))
      .toContain("until you revert it");
  });

  it("explains manual scheduling plainly", () => {
    expect(describeSchedule({ kind: "manual" }, "UTC")).toContain("by hand");
  });

  it("does not say a cancelled campaign starts (#760)", () => {
    const text = describeSchedule(window(), "UTC", "CANCELLED");
    expect(text).toMatch(/^Was to start .*Cancelled, so it will not run\.$/);
    expect(text).not.toMatch(/^Starts/);
  });
});

describe("revert buffer capping", () => {
  it("caps a buffer longer than the window, so the campaign still applies", () => {
    // The bug this guards: a 65-second window with a 1-minute buffer put the revert
    // moment 5 seconds after the start. The campaign went straight from scheduled to
    // nothing -- no error, no prices changed, no explanation.
    const schedule = window({
      startAt: "2026-08-20T09:00:00.000Z",
      endAt: "2026-08-20T09:01:05.000Z",
      revertBufferMinutes: 1,
    });

    // Capped to half the window, so there is a real apply period.
    expect(effectiveBufferMs(schedule as never)).toBe(32_500);

    const state = { schedule, status: "SCHEDULED" as SchedulableStatus };
    expect(dueTransition(state, at("2026-08-20T09:00:10Z"))).toBe("apply");
  });

  it("leaves a sensible buffer untouched", () => {
    const schedule = window({
      startAt: "2026-08-20T09:00:00.000Z",
      endAt: "2026-08-22T09:00:00.000Z",
      revertBufferMinutes: 5,
    });
    expect(effectiveBufferMs(schedule as never)).toBe(5 * 60_000);
  });

  it("warns when the buffer had to be capped", () => {
    const warnings = scheduleWarnings(
      window({
        startAt: "2026-08-20T09:00:00.000Z",
        endAt: "2026-08-20T09:01:05.000Z",
        revertBufferMinutes: 1,
      }),
    );
    expect(warnings.join(" ")).toContain("longer than half the window");
    expect(warnings.join(" ")).toContain("under five minutes");
  });

  it("warns when the end is not after the start", () => {
    const warnings = scheduleWarnings(
      window({ startAt: "2026-08-20T09:00:00.000Z", endAt: "2026-08-20T08:00:00.000Z" }),
    );
    expect(warnings.join(" ")).toContain("never apply");
  });

  it("has nothing to warn about for a manual schedule or a sane window", () => {
    expect(scheduleWarnings({ kind: "manual" })).toEqual([]);
    expect(scheduleWarnings(window())).toEqual([]);
  });
});


describe("recombining a date field and a time field", () => {
  it("joins them into a datetime-local value", () => {
    expect(joinDateAndTime("2026-08-27", "14:30", "09:00")).toBe("2026-08-27T14:30");
  });

  it("takes the default hour when only a date was given", () => {
    // Not an error. The merchant said which day and left the hour to us — refusing
    // would lose a schedule they meant to set.
    expect(joinDateAndTime("2026-08-27", "", "09:00")).toBe("2026-08-27T09:00");
    expect(joinDateAndTime("2026-08-27", null, "23:59")).toBe("2026-08-27T23:59");
  });

  it("is nothing at all when only a time was given", () => {
    // An hour on no particular day cannot be scheduled, and inventing a day would
    // schedule a sale the merchant never asked for.
    expect(joinDateAndTime("", "14:30", "09:00")).toBe("");
    expect(joinDateAndTime(null, "14:30", "09:00")).toBe("");
  });

  it("ignores a malformed time rather than producing a malformed datetime", () => {
    expect(joinDateAndTime("2026-08-27", "2pm", "09:00")).toBe("2026-08-27T09:00");
    expect(joinDateAndTime("2026-08-27", "9:00", "09:00")).toBe("2026-08-27T09:00");
  });

  it("ignores a malformed date entirely", () => {
    expect(joinDateAndTime("27/08/2026", "14:30", "09:00")).toBe("");
  });
});

describe("local times near a clock change (#814, #703)", () => {
  const ZONES = [
    "America/New_York",
    "America/Los_Angeles",
    "Europe/Berlin",
    "Europe/London",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
  const HOUR = 60 * 60_000;

  /** The zone's offset at an instant, read through the app's own formatter. */
  const offsetAt = (at: number, zone: string) =>
    Date.parse(`${utcToLocalInput(new Date(at).toISOString(), zone)}:00Z`) - Math.floor(at / 60_000) * 60_000;

  /** Every instant in 2026 where the zone's offset changes. */
  function changes(zone: string): number[] {
    const out: number[] = [];
    const from = Date.UTC(2026, 0, 1);
    for (let at = from; at < Date.UTC(2027, 0, 1); at += HOUR) {
      if (offsetAt(at, zone) !== offsetAt(at - HOUR, zone)) out.push(at);
    }
    return out;
  }

  it.each(ZONES)("finds both 2026 changes in %s", (zone) => {
    expect(changes(zone).length, zone === "Europe/London" ? "London has DST too" : zone).toBe(2);
  });

  it.each(ZONES)("round-trips every real half hour for 48 hours around each change in %s", (zone) => {
    for (const change of changes(zone)) {
      for (let at = change - 24 * HOUR; at <= change + 24 * HOUR; at += HOUR / 2) {
        const iso = new Date(at).toISOString();
        const typed = utcToLocalInput(iso, zone);
        const resolved = resolveLocalInput(typed, zone)!;

        // What was typed is what the campaign page shows back, always.
        expect(utcToLocalInput(resolved.utc, zone), `${zone} ${typed}`).toBe(typed);
        if (resolved.kind === "exact") {
          expect(resolved.utc, `${zone} ${typed}`).toBe(iso);
        } else {
          // The second of a repeated hour resolves to the first.
          expect(resolved.kind).toBe("ambiguous");
          expect(Date.parse(resolved.utc)).toBeLessThanOrEqual(at);
        }
      }
    }
  });

  it.each(ZONES)("moves a skipped time forward by the jump in %s", (zone) => {
    const spring = changes(zone).find((at) => offsetAt(at, zone) > offsetAt(at - HOUR, zone))!;
    const jump = offsetAt(spring, zone) - offsetAt(spring - HOUR, zone);
    const day = utcToLocalInput(new Date(spring).toISOString(), zone).slice(0, 10);

    let skipped = 0;
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const typed = `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const resolved = resolveLocalInput(typed, zone)!;
      if (resolved.kind !== "skipped") continue;
      skipped++;
      const shown = utcToLocalInput(resolved.utc, zone);
      expect(Date.parse(`${shown}:00Z`) - Date.parse(`${typed}:00Z`), `${zone} ${typed}`).toBe(jump);
    }
    expect(skipped, `${zone} has a skipped hour on ${day}`).toBe(jump / (HOUR / 2));
  });

  it("matches the ticket's cases", () => {
    const at = (typed: string, zone: string) =>
      utcToLocalInput(resolveLocalInput(typed, zone)!.utc, zone);

    // Each of these came back an hour off.
    expect(at("2026-03-08T04:00", "America/New_York")).toBe("2026-03-08T04:00");
    expect(at("2026-03-08T06:30", "America/New_York")).toBe("2026-03-08T06:30");
    expect(at("2026-03-08T09:00", "America/Los_Angeles")).toBe("2026-03-08T09:00");
    expect(at("2026-11-01T03:00", "America/New_York")).toBe("2026-11-01T03:00");
    expect(at("2026-03-29T01:30", "Europe/Berlin")).toBe("2026-03-29T01:30");
    expect(at("2026-10-04T00:00", "Australia/Sydney")).toBe("2026-10-04T00:00");
    expect(at("2026-09-26T14:00", "Pacific/Auckland")).toBe("2026-09-26T14:00");

    // P3.9: a skipped 02:30 becomes 03:30; a repeated 01:30 is the first one (EDT).
    expect(resolveLocalInput("2026-03-08T02:30", "America/New_York")).toEqual({
      utc: "2026-03-08T07:30:00.000Z",
      kind: "skipped",
    });
    expect(resolveLocalInput("2026-11-01T01:30", "America/New_York")).toEqual({
      utc: "2026-11-01T05:30:00.000Z",
      kind: "ambiguous",
    });
  });

  it("says what happened to a skipped or repeated time, and nothing for an ordinary one", () => {
    const zone = "America/New_York";
    const note = (typed: string) => clockNote("starts", typed, resolveLocalInput(typed, zone)!, zone);

    expect(note("2026-03-08T02:30")).toBe(
      "The clocks go forward on 2026-03-08 in America/New_York, so 02:30 does not happen that day. " +
        "The campaign starts at 03:30 instead.",
    );
    expect(note("2026-11-01T01:30")).toMatch(/happens twice that day\. The campaign starts at the first 01:30/);
    expect(note("2026-03-08T09:00")).toBeNull();
  });

  it("carries the notes through parseSchedule into the campaign page's warnings", () => {
    const schedule = parseSchedule({
      kind: "window",
      startAt: "2026-03-08T07:30:00.000Z",
      clockNotes: ["The clocks go forward…", 42],
    });
    expect(scheduleWarnings(schedule)).toContain("The clocks go forward…");
    expect(schedule.kind === "window" && schedule.clockNotes).toEqual(["The clocks go forward…"]);
  });
});
