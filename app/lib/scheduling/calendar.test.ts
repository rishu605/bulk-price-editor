/**
 * Laying campaigns out on a calendar.
 *
 * Mostly about days and timezones. A calendar that files a sale under the wrong day is
 * worse than no calendar: the merchant checks it, believes it, and schedules against it.
 */

import { describe, expect, it } from "vitest";

import {
  addDays,
  layOut,
  localDate,
  monthRange,
  presetStartFor,
  timeOverlaps,
  weekRange,
  weekdayOf,
  type CalendarCampaign,
} from "./calendar";

const campaign = (over: Partial<CalendarCampaign> = {}): CalendarCampaign => ({
  id: "c1",
  name: "Summer sale",
  status: "SCHEDULED",
  startAt: "2026-06-10T12:00:00.000Z",
  endAt: "2026-06-12T12:00:00.000Z",
  ...over,
});

describe("the store's own days", () => {
  it("files an instant under the day it falls on where the store is", () => {
    // 9pm on the 3rd in Los Angeles is 4am on the 4th in UTC. A calendar that used UTC
    // would tell a merchant in California their sale runs on the wrong day.
    const instant = new Date("2026-06-04T04:00:00.000Z");

    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-06-03");
    expect(localDate(instant, "UTC")).toBe("2026-06-04");
  });

  it("handles a zone ahead of UTC too", () => {
    const instant = new Date("2026-06-03T20:00:00.000Z");

    expect(localDate(instant, "Asia/Tokyo")).toBe("2026-06-04");
  });

  it("adds days across a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("adds days across a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("the month grid", () => {
  it("pads to whole weeks", () => {
    // June 2026 starts on a Monday. Padded back to the preceding Sunday, so a sale that
    // ran through the last week of May is still visible — which is exactly the collision
    // a merchant opens the calendar to see.
    const range = monthRange(2026, 6);

    expect(weekdayOf(range.from)).toBe(0);
    expect(weekdayOf(range.to)).toBe(6);
    expect(range.from <= "2026-06-01").toBe(true);
    expect(range.to >= "2026-06-30").toBe(true);
  });

  it("covers every day of the month", () => {
    for (const month of [1, 2, 6, 12]) {
      const range = monthRange(2026, month);
      const days = layOut([], range, "UTC", { year: 2026, month });

      expect(days.filter((day) => day.inFocus).length).toBe(
        new Date(Date.UTC(2026, month, 0)).getUTCDate(),
      );
    }
  });

  it("gives a whole week for a week view", () => {
    const range = weekRange("2026-06-10");

    expect(range.from).toBe("2026-06-07");
    expect(range.to).toBe("2026-06-13");
  });
});

describe("placing campaigns", () => {
  it("occupies every day a campaign spans, not just its first", () => {
    const days = layOut([campaign()], { from: "2026-06-08", to: "2026-06-14" }, "UTC");
    const busy = days.filter((day) => day.entries.length > 0).map((day) => day.date);

    expect(busy).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
  });

  it("marks the first and last day", () => {
    const days = layOut([campaign()], { from: "2026-06-08", to: "2026-06-14" }, "UTC");
    const byDate = new Map(days.map((day) => [day.date, day.entries[0]]));

    expect(byDate.get("2026-06-10")).toMatchObject({ starts: true, ends: false });
    expect(byDate.get("2026-06-12")).toMatchObject({ starts: false, ends: true });
  });

  it("runs an open-ended campaign to the edge of the view and says so", () => {
    // No end date means "until somebody reverts it". Drawing it as a one-day square
    // would suggest it stops, which is the opposite of what it does.
    const days = layOut(
      [campaign({ endAt: null })],
      { from: "2026-06-08", to: "2026-06-14" },
      "UTC",
    );

    expect(days.filter((day) => day.entries.length > 0)).toHaveLength(5);
    expect(days.at(-1)!.entries[0]).toMatchObject({ continues: true, ends: false });
  });

  it("leaves a manual campaign off the calendar entirely", () => {
    // It has no date. Putting it on one would be an invention, and the merchant would
    // reasonably read it as scheduled.
    const days = layOut(
      [campaign({ startAt: null })],
      { from: "2026-06-08", to: "2026-06-14" },
      "UTC",
    );

    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it("skips a campaign entirely outside the range", () => {
    const days = layOut([campaign()], { from: "2026-07-01", to: "2026-07-07" }, "UTC");

    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it("shows the part of a campaign that reaches into the range", () => {
    const days = layOut(
      [campaign({ startAt: "2026-06-01T12:00:00.000Z", endAt: "2026-06-09T12:00:00.000Z" })],
      { from: "2026-06-08", to: "2026-06-14" },
      "UTC",
    );

    expect(days.filter((day) => day.entries.length > 0).map((day) => day.date))
      .toEqual(["2026-06-08", "2026-06-09"]);
    // It did not start here, so the leading edge must not be drawn here either.
    expect(days[0].entries[0].starts).toBe(false);
  });

  it("buckets by the store's day, not the server's", () => {
    const late = campaign({
      startAt: "2026-06-04T04:00:00.000Z",
      endAt: "2026-06-04T06:00:00.000Z",
    });

    const inLa = layOut([late], { from: "2026-06-01", to: "2026-06-07" }, "America/Los_Angeles");
    const inUtc = layOut([late], { from: "2026-06-01", to: "2026-06-07" }, "UTC");

    expect(inLa.find((day) => day.entries.length > 0)!.date).toBe("2026-06-03");
    expect(inUtc.find((day) => day.entries.length > 0)!.date).toBe("2026-06-04");
  });
});

describe("finding campaigns that are live together", () => {
  it("pairs campaigns whose windows cross", () => {
    const pairs = timeOverlaps([
      campaign({ id: "a" }),
      campaign({ id: "b", startAt: "2026-06-11T00:00:00.000Z", endAt: "2026-06-15T00:00:00.000Z" }),
    ]);

    expect(pairs).toEqual([{ a: "a", b: "b" }]);
  });

  it("does not pair back-to-back campaigns", () => {
    // One ends exactly as the other begins. They are consecutive, which is what a
    // merchant scheduling a follow-on sale intends — flagging it would make the badge
    // constant and therefore meaningless.
    const pairs = timeOverlaps([
      campaign({ id: "a", startAt: "2026-06-01T00:00:00.000Z", endAt: "2026-06-05T00:00:00.000Z" }),
      campaign({ id: "b", startAt: "2026-06-05T00:00:00.000Z", endAt: "2026-06-09T00:00:00.000Z" }),
    ]);

    expect(pairs).toEqual([]);
  });

  it("treats an open-ended campaign as overlapping everything after it", () => {
    const pairs = timeOverlaps([
      campaign({ id: "forever", startAt: "2026-06-01T00:00:00.000Z", endAt: null }),
      campaign({ id: "later", startAt: "2027-01-01T00:00:00.000Z", endAt: null }),
    ]);

    expect(pairs).toEqual([{ a: "forever", b: "later" }]);
  });

  it("ignores campaigns with no schedule", () => {
    expect(timeOverlaps([campaign({ id: "a" }), campaign({ id: "b", startAt: null })]))
      .toEqual([]);
  });

  it("pairs each combination once", () => {
    const three = ["a", "b", "c"].map((id) => campaign({ id }));

    expect(timeOverlaps(three)).toHaveLength(3);
  });
});


describe("what actually happened, as distinct from what was scheduled", () => {
  const run = (over: Record<string, string> = {}) => ({
    runId: "r1",
    campaignId: "c1",
    name: "Summer sale",
    kind: "APPLY",
    status: "COMPLETED",
    startedAt: "2026-06-11T15:00:00.000Z",
    ...over,
  });

  it("puts a run on the day it started", () => {
    const days = layOut([campaign()], { from: "2026-06-08", to: "2026-06-14" }, "UTC", undefined, [
      run(),
    ]);

    expect(days.find((day) => day.runs.length > 0)!.date).toBe("2026-06-11");
  });

  it("buckets a run by the store's day too", () => {
    // 3pm UTC is 8am in Los Angeles the same day, but 11pm UTC is the previous
    // afternoon there. A run filed under the wrong day is the same lie as a campaign
    // filed under the wrong day.
    const late = [run({ startedAt: "2026-06-12T04:00:00.000Z" })];

    const inLa = layOut([], { from: "2026-06-08", to: "2026-06-14" }, "America/Los_Angeles", undefined, late);
    const inUtc = layOut([], { from: "2026-06-08", to: "2026-06-14" }, "UTC", undefined, late);

    expect(inLa.find((day) => day.runs.length > 0)!.date).toBe("2026-06-11");
    expect(inUtc.find((day) => day.runs.length > 0)!.date).toBe("2026-06-12");
  });

  it("shows every occurrence of a campaign that ran more than once", () => {
    const days = layOut([campaign()], { from: "2026-06-08", to: "2026-06-14" }, "UTC", undefined, [
      run({ runId: "r1", startedAt: "2026-06-10T10:00:00.000Z" }),
      run({ runId: "r2", kind: "REVERT", startedAt: "2026-06-12T10:00:00.000Z" }),
      run({ runId: "r3", startedAt: "2026-06-12T18:00:00.000Z" }),
    ]);

    expect(days.flatMap((day) => day.runs)).toHaveLength(3);
    expect(days.find((day) => day.date === "2026-06-12")!.runs).toHaveLength(2);
  });

  it("drops a run from outside the visible range", () => {
    const days = layOut([], { from: "2026-06-08", to: "2026-06-14" }, "UTC", undefined, [
      run({ startedAt: "2026-05-01T10:00:00.000Z" }),
    ]);

    expect(days.every((day) => day.runs.length === 0)).toBe(true);
  });
});


describe("pre-filling the wizard from a calendar day", () => {
  it("starts the sale in the morning, not at midnight", () => {
    // A sale that starts at midnight is one nobody sees start. The merchant can still
    // change it; this only decides what is already in the box.
    expect(presetStartFor("2026-08-27")).toBe("2026-08-27T09:00");
  });

  it("leaves the field empty when no day was clicked", () => {
    expect(presetStartFor(null)).toBe("");
    expect(presetStartFor(undefined)).toBe("");
    expect(presetStartFor("")).toBe("");
  });

  it("refuses a malformed date rather than guessing one", () => {
    expect(presetStartFor("tomorrow")).toBe("");
    expect(presetStartFor("2026-8-7")).toBe("");
    expect(presetStartFor("2026-08-27T10:00")).toBe("");
  });

  it("refuses a date that has the right shape but is not a day", () => {
    // The input would silently discard these, leaving the field mysteriously blank
    // rather than obviously empty.
    expect(presetStartFor("2026-02-31")).toBe("");
    expect(presetStartFor("2026-13-01")).toBe("");
  });

  it("keeps a real leap day", () => {
    expect(presetStartFor("2028-02-29")).toBe("2028-02-29T09:00");
  });
});
