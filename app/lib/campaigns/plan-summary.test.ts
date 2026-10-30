/**
 * When a stored plan may be read as the answer, and when a page asks for another (#812).
 *
 * Unknown is stale throughout: a stale plan read as current is the failure stored plans
 * exist to avoid, and a current one read as stale costs only a plan.
 */

import { describe, expect, it } from "vitest";

import {
  PLAN_INPUT_RETENTION_MS,
  PLAN_REQUEST_QUIET_MS,
  PLAN_SUMMARY_MAX_AGE_MS,
  planningText,
  recomputingText,
  shouldRequest,
  summaryState,
} from "./plan-summary";

const now = new Date("2026-10-30T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const stored = (over: Record<string, unknown> = {}) => ({ preview: {}, computedAt: ago(60_000), snapshot: "1:2:", ...over });

describe("a stored plan", () => {
  it("is current when nothing it reads has changed since, and it is young enough", () => {
    expect(summaryState(stored(), false, now)).toBe("current");
  });

  it("is stale the moment the database says something it reads has changed", () => {
    expect(summaryState(stored(), true, now)).toBe("stale");
  });

  it("is stale past its age, whatever the log says", () => {
    expect(summaryState(stored({ computedAt: ago(PLAN_SUMMARY_MAX_AGE_MS + 1) }), false, now)).toBe("stale");
    expect(summaryState(stored({ computedAt: ago(PLAN_SUMMARY_MAX_AGE_MS - 1) }), false, now)).toBe("current");
  });

  it("is stale when anything about it is unknown: no snapshot, or a time that is not one", () => {
    expect(summaryState(stored({ snapshot: null }), false, now)).toBe("stale");
    expect(summaryState(stored({ computedAt: new Date("nonsense") }), false, now)).toBe("stale");
    // From the future: a clock that disagrees is not a plan to trust.
    expect(summaryState(stored({ computedAt: new Date(now.getTime() + 60_000) }), false, now)).toBe("stale");
  });

  it("is missing until a preview is stored, even with a request on its way", () => {
    expect(summaryState(null, false, now)).toBe("missing");
    expect(summaryState(stored({ preview: null }), false, now)).toBe("missing");
    expect(summaryState(stored({ computedAt: null }), false, now)).toBe("missing");
  });

  it("can never be current about a write the log has pruned", () => {
    // Pruning removes rows older than the retention; a plan older than its age is stale anyway.
    expect(PLAN_SUMMARY_MAX_AGE_MS).toBeLessThan(PLAN_INPUT_RETENTION_MS);
  });
});

describe("asking the worker", () => {
  it("asks when nothing was asked, or the last ask was answered by a plan begun after it", () => {
    expect(shouldRequest(null, now)).toBe(true);
    expect(shouldRequest({ requestedAt: null, computedAt: null }, now)).toBe(true);
    expect(shouldRequest({ requestedAt: ago(5_000), computedAt: ago(1_000) }, now)).toBe(true);
  });

  it("does not ask again while one is on its way", () => {
    expect(shouldRequest({ requestedAt: ago(5_000), computedAt: null }, now)).toBe(false);
    expect(shouldRequest({ requestedAt: ago(1_000), computedAt: ago(5_000) }, now)).toBe(false);
  });

  it("asks again once the last ask has gone quiet: a job lost, or failing every attempt", () => {
    expect(shouldRequest({ requestedAt: ago(PLAN_REQUEST_QUIET_MS + 1), computedAt: null }, now)).toBe(true);
  });
});

describe("what the page says", () => {
  it("says when the numbers are from, why they may be wrong, and that they are being redone", () => {
    const text = recomputingText(ago(60 * 60_000), "UTC");
    expect(text).toMatch(/^These numbers were worked out at .*11/);
    expect(text).toContain("They are being worked out again");
  });

  it("says why there is no preview yet, by the scope's size, and that Apply waits for one", () => {
    expect(planningText(102_132)).toContain("It covers 102,132 variants");
    expect(planningText(1)).toContain("It covers 1 variant,");
    expect(planningText(600)).toContain("Apply is offered once there is a preview to confirm");
  });

  it("names no price", () => {
    expect(`${recomputingText(now, "UTC")} ${planningText(10)}`).not.toMatch(/[$€£¥]/);
  });
});
