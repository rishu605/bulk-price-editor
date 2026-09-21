/**
 * When Home admits its catalogue is old.
 *
 * "Last synced 28/08/2026" is what the Store card said on a shop that had last synced
 * 24 days earlier. The date answers *when*; the question underneath it is *how out of
 * date is what I am looking at*, because every price this app computes comes from the
 * catalogue captured then.
 */

import { describe, expect, it } from "vitest";

import { staleSync } from "./stale-sync";

const NOW = "2026-09-21T12:00:00.000Z";
const daysBefore = (days: number) =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

describe("a catalogue that is current", () => {
  it("says nothing at all", () => {
    // A shop that synced this morning does not need telling, and a fact that qualifies
    // itself on every render is one nobody reads.
    expect(staleSync(daysBefore(0), NOW)).toBeUndefined();
    expect(staleSync(daysBefore(3), NOW)).toBeUndefined();
  });

  it("stays quiet right up to the week", () => {
    // The same boundary `formatAgo` uses, so the caption appears exactly when the value
    // above it stops being relative and becomes a bare date.
    expect(staleSync(daysBefore(7), NOW)).toBeUndefined();
  });
});

describe("a catalogue that has gone stale", () => {
  it("says how long, in the unit the date does not give", () => {
    expect(staleSync(daysBefore(24), NOW)).toContain("24 days ago");
  });

  it("says what being stale costs, not merely that it is stale", () => {
    expect(staleSync(daysBefore(24), NOW)).toContain("are not in here yet");
  });

  it("says what to do about it", () => {
    expect(staleSync(daysBefore(24), NOW)).toContain("re-sync");
  });

  it("appears the day after the week is up", () => {
    expect(staleSync(daysBefore(8), NOW)).toContain("8 days ago");
  });
});

describe("what it refuses to guess", () => {
  it("says nothing for a shop that has never synced", () => {
    // "Not yet synced" is the value itself there; a caption would be saying it twice.
    expect(staleSync(null, NOW)).toBeUndefined();
  });

  it("says nothing rather than NaN for an unparseable date", () => {
    expect(staleSync("not a date", NOW)).toBeUndefined();
    expect(staleSync(daysBefore(30), "not a date")).toBeUndefined();
  });
});
