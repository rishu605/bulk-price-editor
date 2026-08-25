/**
 * The staleness boundary.
 *
 * Small surface, disproportionate consequences. Declaring a live run dead is the
 * worse of the two possible errors -- the reaper would mark a run PARTIAL while the
 * process that owns its ledger is still writing to it, and the merchant would be told
 * a campaign had stopped while it was visibly still going. So the threshold resolves
 * in favour of "alive" wherever it is ambiguous.
 */

import { describe, expect, it } from "vitest";

import { isStale } from "./reaper.server";

const now = new Date("2026-08-25T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MINUTE = 60_000;

describe("isStale", () => {
  it("leaves a run that heartbeat recently alone", () => {
    expect(isStale({ heartbeatAt: ago(30_000), startedAt: ago(MINUTE) }, now, 5 * MINUTE)).toBe(
      false,
    );
  });

  it("reclaims a run that has gone quiet past the threshold", () => {
    expect(isStale({ heartbeatAt: ago(6 * MINUTE), startedAt: ago(9 * MINUTE) }, now, 5 * MINUTE)).toBe(
      true,
    );
  });

  it("treats a run exactly at the threshold as alive", () => {
    // Strictly greater than, not at least. A run whose heartbeat lands on the boundary
    // is a run that just reported in, and two processes owning one ledger is a far
    // worse outcome than waiting one more tick.
    expect(isStale({ heartbeatAt: ago(5 * MINUTE), startedAt: null }, now, 5 * MINUTE)).toBe(false);
  });

  it("falls back to startedAt for a run killed before its first heartbeat", () => {
    // The window between the run row being committed and the first chunk finishing.
    // Without this fallback a crash-on-startup would leave a run unreclaimable
    // forever, since it never got far enough to record a heartbeat to go stale.
    expect(isStale({ heartbeatAt: null, startedAt: ago(6 * MINUTE) }, now, 5 * MINUTE)).toBe(true);
  });

  it("prefers the heartbeat over startedAt when both exist", () => {
    // A long-running bulk operation: started hours ago, still reporting in. Judging it
    // on startedAt would reclaim every large run mid-flight.
    expect(isStale({ heartbeatAt: ago(10_000), startedAt: ago(4 * 60 * MINUTE) }, now, 5 * MINUTE)).toBe(
      false,
    );
  });

  it("ignores a run that has not started at all", () => {
    expect(isStale({ heartbeatAt: null, startedAt: null }, now, 5 * MINUTE)).toBe(false);
  });
});
