/**
 * When the page following a background plan reloads itself (#812).
 *
 * The hook cannot be rendered here (`useFetcher` throws outside a data router), so the
 * decision it acts on is tested on its own: reload once a newer plan is stored, or once
 * nothing is on its way any more, and never on an answer heard before this wait began.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";
import { planArrived } from "./usePlanPolling";

const waiting = { asOf: "2026-10-30T10:00:00.000Z", recomputing: "These numbers were worked out at …" };

describe("following a plan the worker is working out", () => {
  it("reloads once a newer plan is stored", () => {
    expect(planArrived(waiting, { at: "2026-10-30T10:05:00.000Z", waiting: false }, true)).toBe(true);
    expect(planArrived({ planning: "Working out…" }, { at: "2026-10-30T10:05:00.000Z", waiting: false }, true)).toBe(true);
  });

  it("waits while the stored plan is the one shown and another is on its way", () => {
    expect(planArrived(waiting, { at: waiting.asOf, waiting: true }, true)).toBe(false);
    expect(planArrived({ planning: "Working out…" }, { at: null, waiting: true }, true)).toBe(false);
  });

  it("reloads when nothing is on its way, so the page asks again", () => {
    expect(planArrived(waiting, { at: waiting.asOf, waiting: false }, true)).toBe(true);
  });

  it("acts only on an answer asked for during this wait, and only while waiting", () => {
    expect(planArrived(waiting, { at: "2026-10-30T10:05:00.000Z", waiting: false }, false)).toBe(false);
    expect(planArrived({ asOf: waiting.asOf }, { at: "2026-10-30T10:05:00.000Z", waiting: false }, true)).toBe(false);
    expect(planArrived(waiting, undefined, true)).toBe(false);
  });

  it("polls the status route, never the page's own loader", () => {
    expect(sourceOf("app/components/campaign/usePlanPolling.ts")).toContain("/app/campaign-status?id=");
  });
});
