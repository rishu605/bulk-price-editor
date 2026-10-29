/**
 * What the recapture page says about a recapture the worker has (#1105), from its row alone.
 */

import { describe, expect, it } from "vitest";

import {
  describeRecapture,
  RECAPTURE_STALE_AFTER_MS,
  recaptureStateOf,
  runningSentence,
  stoppedSentence,
  type RecaptureRow,
} from "./recapture-progress";

const now = new Date("2026-10-29T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const queued: RecaptureRow = {
  id: "rc_1",
  scope: 12_000,
  phase: "queued",
  progress: null,
  heartbeatAt: ago(1_000),
  finishedAt: null,
  outcome: null,
  failure: null,
};

describe("a recapture in the worker, while it runs", () => {
  it("says which step it is on and how far that step has got", () => {
    const reading = recaptureStateOf({ ...queued, phase: "ladders", progress: { done: 2_500, total: 10_000 } }, now);
    expect(reading).toMatchObject({ running: true, phase: "ladders", outcome: null, failure: null });
    expect(reading.text).toBe("Reading wholesale quantity breaks from Shopify: 2,500 of 10,000 prices");

    const recording = recaptureStateOf({ ...queued, phase: "baselines", progress: { done: 4_000, total: 12_400 } }, now);
    expect(recording.text).toBe("Recording baselines: 4,000 of 12,400");
  });

  it("names the step alone before it has a count, and never counts past the total", () => {
    expect(recaptureStateOf(queued, now).text).toBe("Waiting for the background worker");
    expect(describeRecapture("checking", null)).toBe("Checking the scope again");
    expect(describeRecapture("ladders", { done: 0, total: 10_000 })).toBe("Reading wholesale quantity breaks from Shopify");
    expect(describeRecapture("baselines", { done: 1_200, total: 1_000 })).toBe("Recording baselines: 1,000 of 1,000");
  });

  it("says what it covers and that the page may be left, for a tab that never saw it start", () => {
    const state = recaptureStateOf({ ...queued, phase: "ladders", progress: { done: 25, total: 50 } }, now);
    expect(runningSentence(state)).toBe(
      "Recapturing 12,000 variants in the background. Reading wholesale quantity breaks from Shopify: 25 of 50 prices. " +
        "You can leave this page: the recapture carries on without it, and Replace is offered again once it ends.",
    );
  });

  it("treats a phase it does not know as waiting, rather than failing to say anything", () => {
    expect(recaptureStateOf({ ...queued, phase: "something-new" }, now)).toMatchObject({ running: true, text: "Waiting for the background worker" });
    expect(recaptureStateOf({ ...queued, phase: "toString" }, now)).toMatchObject({ phase: null, text: "Waiting for the background worker" });
  });
});

describe("a recapture in the worker, once it ends", () => {
  it("says what it did in the sentence an inline recapture answers with", () => {
    const state = recaptureStateOf(
      {
        ...queued,
        phase: "baselines",
        finishedAt: ago(500),
        outcome: { scope: 4, captured: 8, superseded: 8, alreadyCurrent: 0, wholesale: 4, wholesaleLeft: 0 },
      },
      now,
    );
    expect(state).toMatchObject({ running: false, partial: false, failure: null });
    expect(state.outcome).toBe("Recaptured 8 baselines across 4 variants, superseding 8, including 4 wholesale prices with their quantity breaks.");
  });

  it("marks one that left wholesale prices as they were, and says how to include them", () => {
    const state = recaptureStateOf(
      {
        ...queued,
        finishedAt: ago(500),
        outcome: { scope: 4, captured: 6, superseded: 6, alreadyCurrent: 0, wholesale: 2, wholesaleLeft: 2 },
      },
      now,
    );
    expect(state.partial).toBe(true);
    expect(state.outcome).toMatch(/2 wholesale prices were left as they were: .* Recapture again to include them\.$/);
  });

  it("says why it was refused", () => {
    const failure = "This scope is 5 variants now, not the 4 you were shown, so nothing was recaptured.";
    expect(recaptureStateOf({ ...queued, finishedAt: ago(500), failure }, now)).toMatchObject({ running: false, failure, outcome: null });
  });
});

describe("a recapture whose worker went quiet", () => {
  it("is not running once its heartbeat is older than the stale window, and says where it stopped", () => {
    const stalled = recaptureStateOf(
      { ...queued, phase: "ladders", progress: { done: 100, total: 400 }, heartbeatAt: ago(RECAPTURE_STALE_AFTER_MS + 1) },
      now,
    );
    expect(stalled.running, "a dead worker left the recapture running for good").toBe(false);
    expect(stalled.failure).toBe(
      "The recapture stopped responding while reading wholesale quantity breaks from Shopify, before it recorded anything, " +
        "so nothing was recaptured. Check the scope again, then recapture.",
    );
  });

  it("is still running a moment inside the window", () => {
    expect(recaptureStateOf({ ...queued, heartbeatAt: ago(RECAPTURE_STALE_AFTER_MS) }, now).running).toBe(true);
  });

  it("says the same once it has been closed without an outcome, by the next claim or the worker", () => {
    const closed = recaptureStateOf({ ...queued, phase: "queued", finishedAt: ago(10) }, now);
    expect(closed.failure).toBe(stoppedSentence("queued"));
    expect(closed.failure).toMatch(/never started: the background worker did not pick it up within ten minutes, so nothing was recaptured/);
  });

  it("says baselines it recorded before stopping are kept, only when it had begun recording them", () => {
    expect(stoppedSentence("baselines")).toMatch(/The ones it recorded before it stopped are kept and the rest are as they were\./);
    for (const phase of ["queued", "checking", "ladders"] as const) {
      expect(stoppedSentence(phase), phase).toMatch(/nothing was recaptured/);
    }
  });
});
