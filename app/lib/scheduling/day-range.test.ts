/**
 * The activity filter's days are days in the store's zone (#721).
 *
 * Entries pinned at 23:30 local on the boundary day: in UTC that is already the next day in
 * New York and still the same day in Tokyo, so a UTC range gets one of them wrong either way.
 */

import { describe, expect, it } from "vitest";

import { dayRange } from "./day-range";

const inside = (at: string, range: { gte?: Date; lt?: Date }) =>
  (!range.gte || new Date(at) >= range.gte) && (!range.lt || new Date(at) < range.lt);

describe("a filtered day, in the store's zone", () => {
  it("in New York, keeps 23:30 on the day and drops 23:30 the evening before", () => {
    const range = dayRange("2026-09-25", "2026-09-25", "America/New_York");
    expect(inside("2026-09-26T03:30:00Z", range), "23:30 on 25 Sep in New York").toBe(true);
    expect(inside("2026-09-25T03:30:00Z", range), "23:30 on 24 Sep in New York").toBe(false);
    expect(inside("2026-09-25T04:00:00Z", range), "the first moment of 25 Sep").toBe(true);
    expect(inside("2026-09-26T04:00:00Z", range), "the first moment of 26 Sep").toBe(false);
  });

  it("in Tokyo, keeps 23:30 on the day and drops 23:30 the evening before", () => {
    const range = dayRange("2026-09-25", "2026-09-25", "Asia/Tokyo");
    expect(inside("2026-09-25T14:30:00Z", range), "23:30 on 25 Sep in Tokyo").toBe(true);
    expect(inside("2026-09-24T14:30:00Z", range), "23:30 on 24 Sep in Tokyo").toBe(false);
    expect(inside("2026-09-24T15:00:00Z", range), "the first moment of 25 Sep").toBe(true);
    expect(inside("2026-09-25T15:00:00Z", range), "the first moment of 26 Sep").toBe(false);
  });

  it("spans every day from `from` to `to`", () => {
    const range = dayRange("2026-09-24", "2026-09-26", "America/New_York");
    expect(range).toEqual({ gte: new Date("2026-09-24T04:00:00Z"), lt: new Date("2026-09-27T04:00:00Z") });
  });

  it("is 23 or 25 hours long on a day the clocks change", () => {
    // New York: 8 Mar 2026 springs forward, 1 Nov 2026 falls back.
    const spring = dayRange("2026-03-08", "2026-03-08", "America/New_York");
    expect(spring.lt!.getTime() - spring.gte!.getTime()).toBe(23 * 3_600_000);
    const fall = dayRange("2026-11-01", "2026-11-01", "America/New_York");
    expect(fall.lt!.getTime() - fall.gte!.getTime()).toBe(25 * 3_600_000);
  });

  it("leaves an end open when it is missing or not a date", () => {
    expect(dayRange(undefined, "2026-09-25", "Asia/Tokyo")).toEqual({ lt: new Date("2026-09-25T15:00:00Z") });
    expect(dayRange("2026-09-25", "", "Asia/Tokyo")).toEqual({ gte: new Date("2026-09-24T15:00:00Z") });
    expect(dayRange("25/09/2026", "nonsense", "Asia/Tokyo")).toEqual({});
  });

  it("leaves an end open when it has a date's shape but is not a day (#747)", () => {
    // `Date.UTC` rolls these forward rather than refusing them: 31 Feb filtered to the end
    // of 3 March and 2026-13-45 to February 2027, under a filter still showing what was typed.
    expect(dayRange("garbage", "2026-02-31", "America/New_York")).toEqual({});
    expect(dayRange("2026-13-45", "2026-09-00", "Asia/Tokyo")).toEqual({});
    // A real 29 February is still a day.
    expect(dayRange("2028-02-29", undefined, "UTC")).toEqual({ gte: new Date("2028-02-29T00:00:00Z") });
  });
});
