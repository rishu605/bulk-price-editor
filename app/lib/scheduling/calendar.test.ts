/**
 * Laying campaigns out on a calendar.
 *
 * Mostly about days and timezones. A calendar that files a sale under the wrong day is
 * worse than no calendar: the merchant checks it, believes it, and schedules against it.
 */

import { describe, expect, it } from "vitest";

import {
  addDays,
  isCalendarDay,
  layOut,
  localDate,
  monthRange,
  placeCampaign,
  presetStartFor,
  timeOverlaps,
  weekHeading,
  weekRange,
  weekdayOf,
  type CalendarCampaign,
  type CampaignRunFact,
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

describe("a day from a URL (#747)", () => {
  // The calendar's `on` went straight into `addDays`: `garbage` threw a RangeError and the
  // page became "something went wrong on our side", and `2026-02-31` rolled into March.

  it.each(["2026-09-25", "2028-02-29", "2026-12-31", "2026-01-01"])("accepts %s", (day) => {
    expect(isCalendarDay(day)).toBe(true);
  });

  it.each([
    "garbage",
    "",
    "2026-02-31",
    "2027-02-29",
    "2026-13-01",
    "2026-13-45",
    "2026-00-10",
    "2026-09-00",
    "2026-9-25",
    "2026-09-25T00:00",
    " 2026-09-25",
  ])("refuses %j", (value) => {
    expect(isCalendarDay(value)).toBe(false);
  });

  it("refuses a parameter that is not there", () => {
    expect(isCalendarDay(null)).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
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

describe("the week view's heading (#768)", () => {
  it("names the week's first day, not the day it was asked for", () => {
    // It read "Week of 2026-09-25" above a grid starting on Sunday the 20th.
    expect(weekHeading("2026-09-25")).toBe("Week of Sun 20 Sep 2026");
    expect(weekHeading("2026-09-20")).toBe("Week of Sun 20 Sep 2026");
    expect(weekHeading("2026-09-26")).toBe("Week of Sun 20 Sep 2026");
  });

  it("names the year the week starts in, across a year boundary", () => {
    expect(weekHeading("2027-01-01")).toBe("Week of Sun 27 Dec 2026");
  });

  it("walks back across a month boundary to the Sunday the grid starts on", () => {
    expect(weekHeading("2026-03-04")).toBe("Week of Sun 1 Mar 2026");
    expect(weekHeading("2028-03-02")).toBe("Week of Sun 27 Feb 2028");
  });

  it("spells September the way every other month is spelt", () => {
    // en-GB's locale data now says "Sept", with a comma after the weekday -- a heading
    // that depended on which Node rendered it.
    expect(weekHeading("2026-09-25")).not.toContain("Sept");
    expect(weekHeading("2026-09-25")).not.toContain(",");
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

  it("leaves a campaign with no date off the calendar entirely", () => {
    // A manual campaign nobody has applied has no date. Putting it on one would be an
    // invention, and the merchant would reasonably read it as scheduled. (One that has
    // been applied gets its date from the run -- see `placeCampaign` below.)
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

  it("shows the arrow on the last day when the end is beyond the view, not only when there is none (#768)", () => {
    // A sale ending next month showed a dot on the last visible day, which reads as
    // "stops here", contrary to what `continues` is documented to mean.
    const days = layOut(
      [campaign({ startAt: "2026-06-10T12:00:00.000Z", endAt: "2026-07-20T12:00:00.000Z" })],
      { from: "2026-06-07", to: "2026-06-13" },
      "UTC",
    );

    expect(days.at(-1)!.entries[0]).toMatchObject({ continues: true, ends: false });
  });

  it("does not show the arrow for a campaign ending on the last visible day", () => {
    const days = layOut(
      [campaign({ startAt: "2026-06-10T12:00:00.000Z", endAt: "2026-06-13T12:00:00.000Z" })],
      { from: "2026-06-07", to: "2026-06-13" },
      "UTC",
    );

    expect(days.at(-1)!.entries[0]).toMatchObject({ continues: false, ends: true });
  });
});

describe("a campaign's name on every row it occupies (#768)", () => {
  // October 2026's grid runs Sunday 27 Sep to Saturday 31 Oct: five rows of seven.
  const october = monthRange(2026, 10);
  const longSale = campaign({ startAt: "2026-09-21T10:00:00.000Z", endAt: null });

  it("names it at the start of every week row, in a month after the one it started in", () => {
    // It was a name on the 21st of September and then thirty-five identical dots in
    // October, with nothing on screen to say whose they were.
    const days = layOut([longSale], october, "UTC", { year: 2026, month: 10 });

    expect(days.every((day) => day.entries.length === 1)).toBe(true);
    expect(days.filter((day) => day.entries[0].named).map((day) => day.date)).toEqual([
      "2026-09-27",
      "2026-10-04",
      "2026-10-11",
      "2026-10-18",
      "2026-10-25",
    ]);
    // None of those is where it started, so the grid marks them as a continuation.
    expect(days.some((day) => day.entries[0].starts)).toBe(false);
  });

  it("names it on the day it starts, mid-row", () => {
    const days = layOut([campaign()], { from: "2026-06-07", to: "2026-06-13" }, "UTC");
    const named = days.filter((day) => day.entries[0]?.named).map((day) => day.date);

    expect(named).toEqual(["2026-06-10"]);
  });

  it("leaves every day between names unnamed, so a row is not a wall of the same words", () => {
    const days = layOut([longSale], october, "UTC", { year: 2026, month: 10 });

    expect(days.filter((day) => !day.entries[0].named)).toHaveLength(30);
  });
});

describe("where a campaign that has run is drawn (#768)", () => {
  const NOW = "2026-09-25T12:00:00.000Z";
  const september = monthRange(2026, 9);
  const october = monthRange(2026, 10);

  const apply = (startedAt: string, over: Partial<CampaignRunFact> = {}): CampaignRunFact => ({
    kind: "APPLY",
    status: "COMPLETED",
    startedAt,
    finishedAt: startedAt,
    ...over,
  });
  const revert = (startedAt: string, over: Partial<CampaignRunFact> = {}): CampaignRunFact => ({
    kind: "REVERT",
    status: "COMPLETED",
    startedAt,
    finishedAt: startedAt,
    ...over,
  });

  const daysOf = (
    placed: CalendarCampaign,
    range: { from: string; to: string },
    focus?: { year: number; month: number },
  ) => layOut([placed], range, "UTC", focus).filter((day) => day.entries.length > 0).map((day) => day.date);

  // The two campaigns from dartmode-labs on 25 Sep. "Sale · 21/09/2026" was applied by
  // hand on the 21st and is live; "QA · end before start" was set for the 30th with no
  // end, then applied and reverted by hand on the 24th.
  const manualSale = campaign({ id: "sale", name: "Sale · 21/09/2026", status: "ACTIVE", startAt: null, endAt: null });
  const finished = campaign({
    id: "qa",
    name: "QA · end before start",
    status: "COMPLETED",
    startAt: "2026-09-30T13:00:00.000Z",
    endAt: null,
  });

  it("draws a sale applied by hand from the day it was applied, through today, and on into next month", () => {
    const placed = placeCampaign(manualSale, [apply("2026-09-21T15:00:00.000Z")], NOW);

    expect(placed).toMatchObject({ startAt: "2026-09-21T15:00:00.000Z", endAt: null });

    const inSeptember = daysOf(placed, september, { year: 2026, month: 9 });
    expect(inSeptember[0]).toBe("2026-09-21");
    expect(inSeptember).toContain("2026-09-25");
    // Live until somebody reverts it, so it is live on every day after today too -- and
    // that is what makes it collide with next month's scheduled sale.
    expect(daysOf(placed, october)).toHaveLength(35);
  });

  it("draws a campaign reverted by hand only up to the day it was reverted, and not next month", () => {
    const placed = placeCampaign(
      finished,
      [apply("2026-09-24T10:00:00.000Z"), revert("2026-09-24T10:30:00.000Z")],
      NOW,
    );

    expect(daysOf(placed, september)).toEqual(["2026-09-24"]);
    // Not on the 30th, the start it was reverted days before; not on any day of October.
    expect(daysOf(placed, october)).toEqual([]);
  });

  it("is the acceptance case: the manual sale is drawn today, the finished one is not drawn next month", () => {
    const today = "2026-09-25";
    const campaigns = [
      placeCampaign(manualSale, [apply("2026-09-21T15:00:00.000Z")], NOW),
      placeCampaign(finished, [apply("2026-09-24T10:00:00.000Z"), revert("2026-09-24T10:30:00.000Z")], NOW),
    ];

    const thisMonth = layOut(campaigns, september, "UTC", { year: 2026, month: 9 });
    const nextMonth = layOut(campaigns, october, "UTC", { year: 2026, month: 10 });

    expect(thisMonth.find((day) => day.date === today)!.entries.map((entry) => entry.campaignId)).toEqual(["sale"]);
    expect(nextMonth.flatMap((day) => day.entries).some((entry) => entry.campaignId === "qa")).toBe(false);
    expect(nextMonth.every((day) => day.entries.some((entry) => entry.campaignId === "sale"))).toBe(true);
  });

  it("ends a completed campaign on the day its revert finished, marking that day", () => {
    const placed = placeCampaign(
      campaign({ status: "COMPLETED", startAt: null, endAt: null }),
      [apply("2026-09-10T09:00:00.000Z"), revert("2026-09-15T08:00:00.000Z", { finishedAt: "2026-09-15T08:20:00.000Z" })],
      NOW,
    );

    const days = layOut([placed], september, "UTC");
    expect(days.filter((day) => day.entries.length > 0).map((day) => day.date)).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
    ]);
    expect(days.find((day) => day.date === "2026-09-15")!.entries[0]).toMatchObject({ ends: true, continues: false });
  });

  it("leaves a completed campaign with nothing to say when it stopped off the calendar", () => {
    // The only end anything could invent for it is "forever", which is the bug.
    expect(placeCampaign(finished, [], NOW).startAt).toBeNull();
    expect(placeCampaign(finished, [apply("2026-09-24T10:00:00.000Z")], NOW).startAt).toBeNull();
  });

  it("draws a completed campaign that never ran over its schedule, but never past now", () => {
    const window = campaign({
      status: "COMPLETED",
      startAt: "2026-09-01T09:00:00.000Z",
      endAt: "2026-09-03T09:00:00.000Z",
    });
    expect(placeCampaign(window, [], NOW)).toMatchObject({
      startAt: "2026-09-01T09:00:00.000Z",
      endAt: "2026-09-03T09:00:00.000Z",
    });

    // A completed campaign is not running tomorrow, whatever its schedule says.
    const unreached = campaign({ status: "COMPLETED", startAt: "2026-09-20T09:00:00.000Z", endAt: "2026-10-03T09:00:00.000Z" });
    expect(placeCampaign(unreached, [], NOW).startAt).toBeNull();
  });

  it("draws only the latest stretch of a campaign reverted and applied again", () => {
    // Live 1-5 Sep, off, live again since the 20th. Drawing from its first-ever apply
    // would fill the fortnight it was off.
    const placed = placeCampaign(
      campaign({ status: "ACTIVE", startAt: null, endAt: null }),
      [apply("2026-09-01T09:00:00.000Z"), revert("2026-09-05T09:00:00.000Z"), apply("2026-09-20T09:00:00.000Z")],
      NOW,
    );

    expect(placed.startAt).toBe("2026-09-20T09:00:00.000Z");
  });

  it("starts nothing with an apply that wrote nothing, and ends nothing with a revert that left prices up", () => {
    const placed = placeCampaign(
      campaign({ status: "PARTIAL", startAt: null, endAt: null }),
      [
        apply("2026-09-18T09:00:00.000Z", { status: "FAILED" }),
        apply("2026-09-21T09:00:00.000Z"),
        // Partly undone. Some of its prices are still on the storefront.
        revert("2026-09-23T09:00:00.000Z", { status: "PARTIAL" }),
      ],
      NOW,
    );

    expect(placed).toMatchObject({ startAt: "2026-09-21T09:00:00.000Z", endAt: null });
  });

  it.each(["APPLYING", "ACTIVE", "HELD", "PARTIAL", "REVERTING"])(
    "draws a %s campaign from its first apply, whatever its schedule said",
    (status) => {
      const placed = placeCampaign(
        campaign({ status, startAt: "2026-09-30T09:00:00.000Z", endAt: null }),
        [apply("2026-09-22T09:00:00.000Z")],
        NOW,
      );

      expect(placed.startAt).toBe("2026-09-22T09:00:00.000Z");
    },
  );

  it("ends a live sale at its scheduled end while that is still ahead", () => {
    const placed = placeCampaign(
      campaign({ status: "ACTIVE", startAt: "2026-09-21T09:00:00.000Z", endAt: "2026-10-01T09:00:00.000Z" }),
      [apply("2026-09-21T09:00:00.000Z")],
      NOW,
    );

    expect(placed.endAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("runs a live sale on past a scheduled end that did not take it down", () => {
    // Its window closed on the 22nd and its prices are still up: it runs until somebody
    // reverts it, and stopping the bar on the 22nd would hide a live sale.
    const placed = placeCampaign(
      campaign({ status: "PARTIAL", startAt: "2026-09-20T09:00:00.000Z", endAt: "2026-09-22T09:00:00.000Z" }),
      [apply("2026-09-20T09:00:00.000Z")],
      NOW,
    );

    expect(placed.endAt).toBeNull();
  });

  it("draws a live sale with no runs on record from its schedule, rather than not at all", () => {
    const placed = placeCampaign(
      campaign({ status: "ACTIVE", startAt: "2026-09-21T09:00:00.000Z", endAt: null }),
      [],
      NOW,
    );

    expect(placed.startAt).toBe("2026-09-21T09:00:00.000Z");
  });

  it("draws a scheduled campaign from its schedule, whatever runs it has from before", () => {
    const scheduled = campaign({ status: "SCHEDULED", startAt: "2026-11-27T09:00:00.000Z", endAt: "2026-11-30T09:00:00.000Z" });

    expect(placeCampaign(scheduled, [apply("2026-09-01T09:00:00.000Z")], NOW)).toEqual(scheduled);
  });

  it("puts the manual sale and a scheduled one in the overlap check", () => {
    // It was never counted: with no `startAt`, `timeOverlaps` skipped it.
    const pairs = timeOverlaps([
      placeCampaign(manualSale, [apply("2026-09-21T15:00:00.000Z")], NOW),
      campaign({ id: "bf", status: "SCHEDULED", startAt: "2026-11-27T09:00:00.000Z", endAt: "2026-11-30T09:00:00.000Z" }),
      placeCampaign(finished, [apply("2026-09-24T10:00:00.000Z"), revert("2026-09-24T10:30:00.000Z")], NOW),
    ]);

    expect(pairs).toContainEqual({ a: "sale", b: "bf" });
    // The finished one ran beside the manual sale on the 24th, which is true. It does not
    // reach Black Friday, which, running "until reverted" from the 30th, it used to.
    expect(pairs).toContainEqual({ a: "sale", b: "qa" });
    expect(pairs).not.toContainEqual({ a: "bf", b: "qa" });
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
