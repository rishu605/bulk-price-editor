/**
 * What Home says about a catalogue sync (#801), from the shop row alone.
 */

import { describe, expect, it } from "vitest";

import { baselinesCaptured } from "../lib/onboarding/steps";
import { describeSync, SYNC_STALE_AFTER_MS, syncStateOf } from "./sync-job.server";

const now = new Date("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const idle = { syncStartedAt: null, syncPhase: null, syncProgress: null, syncHeartbeatAt: null, syncFailure: null };

describe("a sync's state, as Home shows it", () => {
  it("says which step it is on and how far that step has got", () => {
    const state = syncStateOf(
      { ...idle, syncStartedAt: ago(60_000), syncPhase: "baselines", syncProgress: { done: 59_132, total: 102_132 }, syncHeartbeatAt: ago(2_000) },
      now,
    );
    expect(state).toMatchObject({ running: true, phase: "baselines", failure: null });
    expect(state.text).toBe("Capturing baselines: 59,132 of 102,132");
  });

  it("counts the catalogue as it is read, with no total to give", () => {
    expect(describeSync("catalogue", { done: 40_000 })).toBe("Reading your catalogue from Shopify: 40,000 variants so far");
    expect(describeSync("queued", null)).toBe("Waiting for the background worker");
  });

  it("treats a sync gone quiet as stopped, says where, and that running it again is safe", () => {
    const state = syncStateOf(
      { ...idle, syncStartedAt: ago(SYNC_STALE_AFTER_MS + 60_000), syncPhase: "markets", syncHeartbeatAt: ago(SYNC_STALE_AFTER_MS + 1) },
      now,
    );
    expect(state.running, "a dead worker left the sync running for good").toBe(false);
    expect(state.failure).toMatch(/stopped responding while reading your markets' price lists\. Run it again: it picks up what is already captured\./);
  });

  it("says why the last one failed, and nothing when there is nothing to say", () => {
    expect(syncStateOf({ ...idle, syncFailure: "The last sync stopped while capturing baselines: boom." }, now).failure).toMatch(/boom/);
    expect(syncStateOf(idle, now)).toEqual({ running: false, phase: null, text: null, startedAt: null, failure: null });
  });
});

describe("the baselines step is done when they are captured, not begun", () => {
  it("is not done on the first chunk of a capture still running", () => {
    expect(baselinesCaptured({ withBaseline: 43_000, missing: 59_132 }, false, true)).toBe(false);
  });

  it("is not done while a sync runs, even over an older capture", () => {
    expect(baselinesCaptured({ withBaseline: 102_132, missing: 0 }, true, true)).toBe(false);
  });

  it("is done once a sync has finished, or every surface has one however it got it", () => {
    expect(baselinesCaptured({ withBaseline: 102_132, missing: 2 }, true, false)).toBe(true);
    expect(baselinesCaptured({ withBaseline: 50, missing: 0 }, false, false)).toBe(true);
    expect(baselinesCaptured({ withBaseline: 0, missing: 0 }, true, false), "nothing captured is not done").toBe(false);
  });
});
