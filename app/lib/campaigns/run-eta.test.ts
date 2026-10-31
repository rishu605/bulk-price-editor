/**
 * How long a run has left, and when it will not say (#820).
 *
 * The failure this guards against is a confident number the run has not earned: "about 2
 * minutes left" from three rows, from a bulk operation nobody can see into, or from a run
 * that stopped a while ago. Silence is the answer in each of those, and most of what is
 * asserted here is where it says nothing.
 */

import { describe, expect, it } from "vitest";

import { ETA_AFTER_PERCENT, QUIET_AFTER_MS, runEta, type RunProgress } from "./run-eta";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A sync run of 1,000 rows, started a minute ago and heard from just now. */
function progress(over: Partial<RunProgress> = {}): RunProgress {
  return { path: "SYNC", rows: 1_000, written: 500, startedAt: ago(60_000), heartbeatAt: ago(1_000), ...over };
}

describe("the estimate", () => {
  it("puts the rows left at the rate the written ones took", () => {
    // 100 rows in a minute, 900 to go: nine minutes.
    expect(runEta(progress({ written: 100 }), NOW)).toBe("about 9 minutes left");
  });

  it("rounds to the nearest whole minute", () => {
    // 1,000 rows, 60 s elapsed: `left` is 60 s × (1000 − w) / w.
    expect(runEta(progress({ written: 400 }), NOW), "90 s").toBe("about 2 minutes left");
    expect(runEta(progress({ written: 410 }), NOW), "86 s").toBe("about a minute left");
    expect(runEta(progress({ written: 250 }), NOW), "180 s").toBe("about 3 minutes left");
    expect(runEta(progress({ written: 200 }), NOW), "240 s").toBe("about 4 minutes left");
  });

  it("says a minute, not one minutes", () => {
    expect(runEta(progress({ written: 500 }), NOW), "exactly 60 s").toBe("about a minute left");
  });

  it("says under a minute below one, rather than counting seconds", () => {
    // An average's seconds are a precision it does not have, and the page asks every five.
    expect(runEta(progress({ written: 510 }), NOW), "58 s").toBe("under a minute left");
    expect(runEta(progress({ written: 999 }), NOW)).toBe("under a minute left");
  });
});

describe("the 5% gate", () => {
  it("says nothing before 5% of the rows are written", () => {
    expect(ETA_AFTER_PERCENT).toBe(5);
    expect(runEta(progress({ written: 0 }), NOW), "nothing written").toBeNull();
    expect(runEta(progress({ written: 49 }), NOW), "4.9%").toBeNull();
  });

  it("speaks from exactly 5%", () => {
    expect(runEta(progress({ written: 50 }), NOW), "5.0%").toBe("about 19 minutes left");
  });

  it("holds on a small run too", () => {
    // One row of twenty is 5%; one of twenty-one is not.
    expect(runEta(progress({ rows: 20, written: 1 }), NOW)).toBe("about 19 minutes left");
    expect(runEta(progress({ rows: 21, written: 1 }), NOW), "4.8%").toBeNull();
  });
});

describe("where it says nothing", () => {
  it("a stalled run: nothing heard for longer than a dozen heartbeats", () => {
    expect(QUIET_AFTER_MS).toBe(60_000);
    expect(runEta(progress({ written: 100, heartbeatAt: ago(QUIET_AFTER_MS + 1) }), NOW)).toBeNull();
    // At the threshold it is slow, not silent.
    expect(runEta(progress({ written: 100, heartbeatAt: ago(QUIET_AFTER_MS) }), NOW)).toBe("about 9 minutes left");
  });

  it("a stalled run with no heartbeat yet is judged from its start", () => {
    expect(runEta(progress({ written: 100, heartbeatAt: null, startedAt: ago(30_000) }), NOW)).toBe("about 5 minutes left");
    expect(runEta(progress({ written: 100, heartbeatAt: null, startedAt: ago(QUIET_AFTER_MS + 1) }), NOW)).toBeNull();
  });

  it("a run past 100%, or at it: what is left is not in these rows", () => {
    // Tags and market prices come after the last base price, and "under a minute" over
    // three more minutes of tagging is the guess this exists not to make.
    expect(runEta(progress({ written: 1_000 }), NOW)).toBeNull();
    expect(runEta(progress({ written: 1_200 }), NOW)).toBeNull();
  });

  it("a run with no start time", () => {
    expect(runEta(progress({ startedAt: null }), NOW)).toBeNull();
    expect(runEta(progress({ startedAt: null, heartbeatAt: null }), NOW)).toBeNull();
  });

  it("a start stamped ahead of this clock", () => {
    expect(runEta(progress({ startedAt: new Date(NOW.getTime() + 5_000), heartbeatAt: NOW }), NOW)).toBeNull();
  });

  it("a bulk operation, whose rows settle together when Shopify is done", () => {
    expect(runEta(progress({ path: "BULK" }), NOW)).toBeNull();
  });

  it("a run that has not chosen a path yet", () => {
    expect(runEta(progress({ path: null }), NOW)).toBeNull();
  });

  it("a run with no rows to write", () => {
    expect(runEta(progress({ rows: 0, written: 0 }), NOW)).toBeNull();
  });
});
