import { describe, expect, it } from "vitest";

import { entryLabel } from "../scheduling/calendar";
import { STARTING_LATE_GRACE_MS, startingLateText } from "../scheduling/ending-late";
import { nextMoments } from "../scheduling/upcoming";
import { describeSchedule, parseSchedule } from "../scheduling/window";
import { lifecycleBadge, lifecycleOf } from "./lifecycle-of";

const start = "2026-10-15T10:00:00.000Z";
const end = "2026-10-15T12:00:00.000Z";
const window = { kind: "window", startAt: start, endAt: end };
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs);

describe("a campaign still applying past its start or its end (#1056)", () => {
  it("is starting late only after the grace a tick and a small apply need, and ending late wins", () => {
    expect(startingLateText(window, "APPLYING", "UTC", at(start, STARTING_LATE_GRACE_MS - 1))).toBeNull();
    expect(startingLateText(window, "APPLYING", "UTC", at(start, STARTING_LATE_GRACE_MS))).toBe("15 Oct 2026, 10:00 (UTC)");
    expect(startingLateText(window, "ACTIVE", "UTC", at(start, 60 * 60_000))).toBeNull();
    expect(startingLateText({ kind: "manual" }, "APPLYING", "UTC", at(start, 60 * 60_000))).toBeNull();
    expect(startingLateText(window, "APPLYING", "UTC", at(end)), "ending late says more").toBeNull();
  });

  it("is labelled the same wherever a list shows it", () => {
    expect(lifecycleOf("APPLYING", window, at(start, 10 * 60_000))).toMatchObject({ label: "Applying — starting late", tone: "warning" });
    expect(lifecycleOf("APPLYING", window, at(end))).toMatchObject({ label: "Applying — ending late", tone: "warning" });
    expect(lifecycleOf("APPLYING", window, at(start, 30_000)).label).toBe("Applying");
    expect(lifecycleBadge("APPLYING", window, at(end))).toEqual({ label: "Applying — ending late", tone: "warning" });
  });

  it("is carried to Home's upcoming list and the calendar's spoken label", () => {
    const badge = lifecycleBadge("APPLYING", window, at(end));
    const [moment] = nextMoments([{ id: "c1", name: "Weekend", status: "APPLYING", lifecycle: badge, startAt: start, endAt: "2026-10-16T00:00:00.000Z" }], end);
    expect(moment.lifecycle).toEqual(badge);
    expect(entryLabel({ name: "Weekend", status: "APPLYING", lifecycle: badge, day: 1, days: 2 })).toBe("Weekend, applying — ending late, day 1 of 2");
    expect(entryLabel({ name: "Weekend", status: "APPLYING", day: 1, days: 2 })).toBe("Weekend, applying, day 1 of 2");
  });

  it("stops the Schedule card promising an early revert once the revert is waiting on the apply", () => {
    const schedule = parseSchedule(window);
    expect(describeSchedule(schedule, "UTC", "ACTIVE", at(start))).toMatch(/Reverting begins 5 minutes early/);
    expect(describeSchedule(schedule, "UTC", "APPLYING", at(start))).toMatch(/Reverting begins 5 minutes early/);
    expect(describeSchedule(schedule, "UTC", "APPLYING", at(end))).toMatch(
      /^Starts .*, reverts .* \(UTC\)\. It is still applying, so its revert waits for that to finish and begins as soon as it does\.$/,
    );
  });
});
