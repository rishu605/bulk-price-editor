/**
 * Which occurrence a scheduled run belongs to.
 *
 * The unique index on (campaign, occurrence, kind) is documented as making recurring
 * runs idempotent so a duplicate tick cannot double-apply. It only does that if the key
 * names the occurrence. Keyed on the instant a run started — as it was — two ticks two
 * milliseconds apart produce two keys and two runs, and the index fires only on an
 * exact-millisecond collision, which is the case where it is least useful.
 */

import { describe, expect, it } from "vitest";

import { occurrenceKeyFor, type Schedule } from "./window";

const window = (over: Partial<Extract<Schedule, { kind: "window" }>> = {}): Schedule => ({
  kind: "window",
  startAt: "2026-09-01T09:00:00.000Z",
  endAt: "2026-09-08T23:00:00.000Z",
  ...over,
});

describe("occurrenceKeyFor", () => {
  it("gives two ticks of the same window the same key", () => {
    // The whole point. Whichever tick loses the insert stands down instead of applying
    // a second time.
    const a = occurrenceKeyFor(window(), "apply", new Date("2026-09-01T09:00:00Z"));
    const b = occurrenceKeyFor(window(), "apply", new Date("2026-09-01T09:00:02Z"));
    expect(a).toBe(b);
  });

  it("keys an apply on the start and a revert on the end", () => {
    expect(occurrenceKeyFor(window(), "apply")).toBe("APPLY@2026-09-01T09:00:00.000Z");
    expect(occurrenceKeyFor(window(), "revert")).toBe("REVERT@2026-09-08T23:00:00.000Z");
  });

  it("treats apply and revert of one window as different occurrences", () => {
    // They are, and the index keys on kind as well — but the instants differing is what
    // makes the intent readable in the table.
    expect(occurrenceKeyFor(window(), "apply")).not.toBe(occurrenceKeyFor(window(), "revert"));
  });

  it("normalises equivalent timestamps to one occurrence", () => {
    // "…T09:00:00Z" and "…T09:00:00.000Z" are the same moment. Keying on the raw string
    // would make them two occurrences and let the same window apply twice.
    const terse = occurrenceKeyFor(window({ startAt: "2026-09-01T09:00:00Z" }), "apply");
    const precise = occurrenceKeyFor(window({ startAt: "2026-09-01T09:00:00.000Z" }), "apply");
    expect(terse).toBe(precise);
  });

  it("distinguishes different windows", () => {
    const september = occurrenceKeyFor(window(), "apply");
    const october = occurrenceKeyFor(window({ startAt: "2026-10-01T09:00:00.000Z" }), "apply");
    expect(september).not.toBe(october);
  });

  it("falls back to the instant for a window with no end", () => {
    // Reverted by hand, so there is no scheduled instant to name.
    const key = occurrenceKeyFor(
      window({ endAt: undefined }),
      "revert",
      new Date("2026-09-10T12:00:00.000Z"),
    );
    expect(key).toBe("REVERT@2026-09-10T12:00:00.000Z");
  });

  it("keeps manual runs keyed on the instant", () => {
    // Deduplicating those is not what the index is for. A merchant clicking Apply is
    // watching the screen and the button disables itself; collapsing two deliberate
    // applies seconds apart would break apply/revert/apply-again for no safety gained.
    const first = occurrenceKeyFor({ kind: "manual" }, "apply", new Date(1_000));
    const second = occurrenceKeyFor({ kind: "manual" }, "apply", new Date(2_000));
    expect(first).not.toBe(second);
    expect(first).toBe("APPLY-1000");
  });
});
