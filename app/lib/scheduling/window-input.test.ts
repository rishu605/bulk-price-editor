/**
 * Whether a typed window can ever run (#760).
 *
 * An end before the start used to be saved, and the campaign sat in Scheduled forever --
 * with the warning shown only after it had been created, on a page that could not fix it.
 */

import { describe, expect, it } from "vitest";

import { scheduledWindow, windowFromFields, windowInputProblem } from "./window-input";

const now = new Date("2026-11-01T12:00:00Z");
const describeIso = (iso: string) => iso.slice(0, 16);
const check = (startUtc: string | null, endUtc: string | null, futureStart = false) =>
  windowInputProblem({ startUtc, endUtc, now, describe: describeIso, futureStart });

describe("a window that can run", () => {
  it("passes a start with no end, and a start before a later end", () => {
    expect(check("2026-11-27T05:00:00Z", null)).toBeNull();
    expect(check("2026-11-27T05:00:00Z", "2026-11-30T04:59:00Z")).toBeNull();
  });

  it("passes no dates at all -- a campaign run by hand", () => {
    expect(check(null, null)).toBeNull();
  });

  it("lets a new campaign start in the past, which the next tick applies", () => {
    // Setting up a sale that "starts now" types a start a minute ago.
    expect(check("2026-11-01T11:59:00Z", "2026-11-02T00:00:00Z")).toBeNull();
  });
});

describe("a window that never could", () => {
  it("refuses an end at or before the start, naming End", () => {
    const at = check("2026-11-27T05:00:00Z", "2026-11-27T05:00:00Z");
    expect(at).toMatch(/^End: 2026-11-27T05:00 is not after the start, 2026-11-27T05:00/);
    expect(check("2026-11-27T05:00:00Z", "2026-11-26T05:00:00Z")).toMatch(/^End: .*would never apply/);
  });

  it("refuses an end that has already passed", () => {
    expect(check("2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z")).toMatch(/^End: .*has already passed/);
  });

  it("refuses an end with no start, rather than dropping the end silently", () => {
    expect(check(null, "2026-11-30T00:00:00Z")).toMatch(/^Start: an end was given without a start/);
  });

  it("refuses a past start when editing, pointing at Apply for starting now", () => {
    expect(check("2026-11-01T11:59:00Z", null, true)).toMatch(/^Start: .*already passed.*Apply to storefront/);
    expect(check("2026-11-02T00:00:00Z", null, true)).toBeNull();
  });
});

describe("reading the four fields", () => {
  it("reads them in the store's zone, with the forms' default times", () => {
    const window = windowFromFields(
      { startDate: "2026-11-27", startTime: "", endDate: "2026-11-30", endTime: "" },
      "America/New_York",
    );
    expect(window.startUtc).toBe("2026-11-27T14:00:00.000Z");
    expect(window.endUtc).toBe("2026-12-01T04:59:00.000Z");
    expect(window.clockNotes).toEqual([]);
  });

  it("gives back what the dialog prefills, so saving unchanged fields keeps the dates", () => {
    const shown = scheduledWindow(
      { kind: "window", startAt: "2026-11-27T14:00:00.000Z", endAt: "2026-12-01T04:59:00.000Z" },
      "America/New_York",
    )!;
    const read = windowFromFields(
      {
        startDate: shown.start.slice(0, 10),
        startTime: shown.start.slice(11),
        endDate: shown.end.slice(0, 10),
        endTime: shown.end.slice(11),
      },
      "America/New_York",
    );

    expect(read.startUtc).toBe("2026-11-27T14:00:00.000Z");
    expect(read.endUtc).toBe("2026-12-01T04:59:00.000Z");
    expect(shown.startText).toContain("America/New_York");
  });

  it("has nothing to show for a campaign run by hand", () => {
    expect(scheduledWindow({ kind: "manual" }, "UTC")).toBeNull();
  });
});
