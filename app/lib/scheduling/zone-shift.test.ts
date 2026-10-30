/**
 * A campaign typed in one zone, on a store now in another (#799).
 *
 * Every store was UTC until its first sync, and the sync then wrote the real zone under
 * every campaign already scheduled: 09:00 typed as "your store's zone" opened at 04:00 in
 * New York. The instants were never wrong -- the local time was, silently. These decide
 * which moments now read differently, how to say it, and what keeping the typed time is.
 */

import { describe, expect, it } from "vitest";

import { ownRecordOf } from "../campaigns/own-record";
import { parseSchedule, type Schedule } from "./window";
import { describeZoneShift, isTimeZone, keptWallClock, zoneShiftOf } from "./zone-shift";

const NOW = new Date("2026-10-15T12:00:00Z");
type Window = Extract<Schedule, { kind: "window" }>;

/** 1 Dec 2026, 09:00 to 23:59, typed in `zone` as the editor would have stored it. */
function typed(zone: string | undefined, startAt = "2026-12-01T09:00:00.000Z", endAt?: string): Window {
  return { kind: "window", startAt, ...(endAt ? { endAt } : {}), revertBufferMinutes: 5, ...(zone ? { zone } : {}) };
}

describe("isTimeZone", () => {
  it.each([["UTC"], ["America/New_York"], ["Asia/Kolkata"], ["Asia/Calcutta"]])("accepts %s", (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });

  it.each([[null], [undefined], [""], ["  "], ["Mars/Olympus"], [42]])("refuses %j", (zone) => {
    expect(isTimeZone(zone)).toBe(false);
  });
});

describe("which moments read differently on the store's clock", () => {
  it("names the start of a 9 AM sale typed in UTC on a store now in New York, at 4 AM", () => {
    const shift = zoneShiftOf(typed("UTC"), "SCHEDULED", "America/New_York", NOW);
    expect(shift).toMatchObject({ from: "UTC", to: "America/New_York" });
    expect(shift?.moments).toEqual([
      { which: "start", at: "2026-12-01T09:00:00.000Z", typed: "2026-12-01T09:00", typedText: "1 Dec 2026, 09:00", nowText: "1 Dec 2026, 04:00" },
    ]);
  });

  it("names both ends of a scheduled window, and only the end of a live one", () => {
    const window = typed("America/New_York", "2026-12-01T14:00:00.000Z", "2026-12-02T04:59:00.000Z");
    const which = (status: string) =>
      zoneShiftOf(window, status, "America/Los_Angeles", NOW)?.moments.map((moment) => moment.which) ?? [];
    expect(which("SCHEDULED")).toEqual(["start", "end"]);
    for (const live of ["ACTIVE", "HELD", "PARTIAL"]) expect(which(live), live).toEqual(["end"]);
  });

  it("says nothing about a campaign mid-run, finished, called off or run by hand", () => {
    const window = typed("UTC", "2026-12-01T09:00:00.000Z", "2026-12-02T09:00:00.000Z");
    for (const status of ["APPLYING", "REVERTING", "COMPLETED", "CANCELLED", "DRAFT"]) {
      expect(zoneShiftOf(window, status, "America/New_York", NOW), status).toBeNull();
    }
    expect(zoneShiftOf({ kind: "manual" }, "DRAFT", "America/New_York", NOW)).toBeNull();
  });

  it("says nothing about moments already behind it", () => {
    const started = typed("UTC", "2026-10-01T09:00:00.000Z", "2026-10-10T09:00:00.000Z");
    expect(zoneShiftOf(started, "ACTIVE", "America/New_York", NOW)).toBeNull();
  });

  it("does not guess the zone of a campaign saved before it was recorded", () => {
    // Its times were typed in whatever the row held then. `recordShopTimezone` stamps that
    // zone when the row changes; until then there is nothing honest to say.
    expect(zoneShiftOf(typed(undefined), "SCHEDULED", "America/New_York", NOW)).toBeNull();
  });

  it("says nothing when the clocks agree: the same zone, or one zone under two names", () => {
    expect(zoneShiftOf(typed("America/New_York"), "SCHEDULED", "America/New_York", NOW)).toBeNull();
    expect(zoneShiftOf(typed("Asia/Calcutta"), "SCHEDULED", "Asia/Kolkata", NOW)).toBeNull();
    // Toronto and New York share a clock on these dates.
    expect(zoneShiftOf(typed("America/Toronto"), "SCHEDULED", "America/New_York", NOW)).toBeNull();
  });

  it("names only the moment that moved when two zones agree on one date and not the other", () => {
    // Phoenix keeps standard time all year; Denver does not. In January they agree, and in
    // July Denver is an hour ahead.
    const window = typed("America/Phoenix", "2027-01-15T16:00:00.000Z", "2027-07-15T16:00:00.000Z");
    expect(zoneShiftOf(window, "SCHEDULED", "America/Denver", NOW)?.moments.map((moment) => moment.which)).toEqual(["end"]);
  });

  it("does not crash on a zone nothing can convert in", () => {
    expect(zoneShiftOf(typed("Mars/Olympus"), "SCHEDULED", "America/New_York", NOW)).toBeNull();
    expect(zoneShiftOf(typed("UTC"), "SCHEDULED", "Mars/Olympus", NOW)).toBeNull();
  });
});

describe("keeping the times as they were set", () => {
  it("moves 09:00 UTC to 09:00 in New York, which is 14:00 UTC in winter and 13:00 in summer", () => {
    for (const [startAt, kept] of [
      ["2026-12-01T09:00:00.000Z", "2026-12-01T14:00:00.000Z"],
      ["2027-07-01T09:00:00.000Z", "2027-07-01T13:00:00.000Z"],
    ]) {
      const window = typed("UTC", startAt);
      const shift = zoneShiftOf(window, "SCHEDULED", "America/New_York", NOW)!;
      expect(keptWallClock(window, shift)).toEqual({ startUtc: kept, endUtc: null, clockNotes: [] });
    }
  });

  it("moves only the end of a live campaign, and leaves its start where it happened", () => {
    const window = typed("UTC", "2026-10-01T09:00:00.000Z", "2026-12-01T23:59:00.000Z");
    const shift = zoneShiftOf(window, "ACTIVE", "America/New_York", NOW)!;
    expect(keptWallClock(window, shift)).toEqual({
      startUtc: "2026-10-01T09:00:00.000Z",
      endUtc: "2026-12-02T04:59:00.000Z",
      clockNotes: [],
    });
  });

  it("resolves a typed time the new zone's clocks skip, and says so", () => {
    // 02:30 on 14 Mar 2027 does not happen in New York: the clocks go from 02:00 to 03:00.
    const window = typed("UTC", "2027-03-14T02:30:00.000Z");
    const kept = keptWallClock(window, zoneShiftOf(window, "SCHEDULED", "America/New_York", NOW)!);
    expect(kept.startUtc).toBe("2027-03-14T07:30:00.000Z"); // 03:30 EDT
    expect(kept.clockNotes).toEqual([
      "The clocks go forward on 2027-03-14 in America/New_York, so 02:30 does not happen that day. The campaign starts at 03:30 instead.",
    ]);
  });
});

describe("the sentence", () => {
  it("gives the time alone when the date is the same on both clocks", () => {
    const shift = zoneShiftOf(typed("UTC", "2026-12-01T09:00:00.000Z", "2026-12-01T23:00:00.000Z"), "SCHEDULED", "America/New_York", NOW)!;
    expect(describeZoneShift(shift)).toBe(
      "Its times were set in UTC, and Shopify has your store in America/New_York. On your store's clock it " +
        "starts 1 Dec 2026, 04:00, not 09:00 and ends 1 Dec 2026, 18:00, not 23:00.",
    );
  });

  it("gives the whole date when the move crosses midnight", () => {
    const shift = zoneShiftOf(typed("UTC", "2026-12-01T02:00:00.000Z"), "SCHEDULED", "America/New_York", NOW)!;
    expect(describeZoneShift(shift)).toMatch(/starts 30 Nov 2026, 21:00, not 1 Dec 2026, 02:00\.$/);
  });
});

describe("the zone is part of the window, not of what the campaign prices", () => {
  it("survives parsing, and is one of the keys a copy or an unschedule drops", () => {
    // Unschedule keeps only the campaign's own record by name and Duplicate keeps nothing of
    // the blob (#1141), so no key of the window rides along. A zone left behind on a copy
    // would describe dates the copy does not have.
    const parsed = parseSchedule({ ...typed("America/New_York", "2026-12-01T14:00:00.000Z", "2026-12-02T04:59:00.000Z"), clockNotes: ["x"] });
    expect(parsed).toMatchObject({ zone: "America/New_York" });
    expect(ownRecordOf(parsed)).toEqual({});
  });
});
