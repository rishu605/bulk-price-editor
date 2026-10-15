import { describe, expect, it } from "vitest";

import { endingLateText, isEndingLate, toldEndingLate, withEndingLate } from "./ending-late";
import { dueTransition, parseSchedule, revertMoment } from "./window";

// 13:40–14:10 New York with a 5-minute buffer, as anchor-perf's "QA · sched" was: reverting
// was due to begin at 18:05 UTC.
const raw = {
  kind: "window",
  startAt: "2026-09-25T17:40:00.000Z",
  endAt: "2026-09-25T18:10:00.000Z",
  revertBufferMinutes: 5,
};
const window = parseSchedule(raw);
const at = (iso: string) => new Date(iso);

describe("when reverting is due to begin", () => {
  it("is the end less the buffer, and is when the scheduler would revert a live campaign", () => {
    expect(revertMoment(window)).toBe(Date.parse("2026-09-25T18:05:00.000Z"));
    expect(dueTransition({ schedule: window, status: "ACTIVE" }, at("2026-09-25T18:04:59.000Z"))).toBeNull();
    expect(dueTransition({ schedule: window, status: "ACTIVE" }, at("2026-09-25T18:05:00.000Z"))).toBe("revert");
  });

  it("is never, for a window with no end or a campaign run by hand", () => {
    expect(revertMoment(parseSchedule({ ...raw, endAt: undefined }))).toBeNull();
    expect(revertMoment(parseSchedule({ kind: "manual" }))).toBeNull();
  });
});

describe("a campaign ending late (#829)", () => {
  it("is one still applying at or after the moment its revert was due", () => {
    expect(isEndingLate(window, "APPLYING", at("2026-09-25T18:04:59.000Z"))).toBe(false);
    expect(isEndingLate(window, "APPLYING", at("2026-09-25T18:05:00.000Z"))).toBe(true);
    expect(isEndingLate(window, "APPLYING", at("2026-09-25T19:06:00.000Z"))).toBe(true);
  });

  it("is never one whose apply has finished, which the scheduler simply reverts", () => {
    for (const status of ["SCHEDULED", "ACTIVE", "PARTIAL", "HELD", "REVERTING", "COMPLETED"]) {
      expect(isEndingLate(window, status, at("2026-09-25T19:06:00.000Z")), status).toBe(false);
    }
  });

  it("is never one with no end, which nothing reverts on its own", () => {
    expect(isEndingLate(parseSchedule({ ...raw, endAt: undefined }), "APPLYING", at("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("names its window's end in the shop's zone for the page, and says nothing while it is on time", () => {
    expect(endingLateText(raw, "APPLYING", "America/New_York", at("2026-09-25T18:26:00.000Z"))).toBe(
      "25 Sep 2026, 14:10 (America/New_York)",
    );
    expect(endingLateText(raw, "APPLYING", "America/New_York", at("2026-09-25T17:57:00.000Z"))).toBeNull();
    expect(endingLateText(raw, "ACTIVE", "America/New_York", at("2026-09-25T18:26:00.000Z"))).toBeNull();
  });
});

describe("telling the merchant a campaign is ending late", () => {
  it("is remembered against the end it was about", () => {
    const told = withEndingLate(raw, at("2026-09-25T18:05:30.000Z"));
    expect(toldEndingLate(told)).toBe(true);
    // The marked blob still parses as the same window.
    expect(parseSchedule(told)).toEqual(window);
  });

  it("is forgotten once the end moves, and absent when never told", () => {
    const told = withEndingLate(raw, at("2026-09-25T18:05:30.000Z"));
    expect(toldEndingLate({ ...told, endAt: "2026-09-26T18:10:00.000Z" })).toBe(false);
    expect(toldEndingLate(raw)).toBe(false);
    expect(toldEndingLate({ kind: "manual" })).toBe(false);
  });
});
