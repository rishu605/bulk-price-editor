/**
 * When a page waiting on a run reloads itself (#790).
 *
 * The hook's timers are wiring; the decision is this function, and the decision is where
 * a page either sits on "Applying" for ever or reloads itself in a loop.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";
import { finished, IN_FLIGHT } from "./useRunPolling";

describe("a page following a run", () => {
  it("reloads once the run it is showing has ended", () => {
    expect(finished("APPLYING", "ACTIVE", true)).toBe(true);
    expect(finished("APPLYING", "PARTIAL", true)).toBe(true);
    expect(finished("REVERTING", "COMPLETED", true)).toBe(true);
  });

  it("keeps waiting while the run is still writing", () => {
    expect(finished("APPLYING", "APPLYING", true)).toBe(false);
    expect(finished("APPLYING", null, true)).toBe(false);
    expect(finished("APPLYING", undefined, true)).toBe(false);
  });

  it("ignores an answer it did not ask for during this run", () => {
    // The fetcher still holds the "Active" it heard when the previous run ended. Acting on
    // it straight after a re-apply reloads the page, which reads Applying, which acts on
    // the same stale answer again -- a reload loop until the next poll lands.
    expect(finished("APPLYING", "ACTIVE", false)).toBe(false);
  });

  it("has nothing to follow on a page that is not mid-run", () => {
    for (const state of ["DRAFT", "SCHEDULED", "ACTIVE", "HELD", "PARTIAL", "COMPLETED"]) {
      expect(IN_FLIGHT.has(state), state).toBe(false);
      expect(finished(state, "ACTIVE", true), state).toBe(false);
    }
  });

  it("does not offer Apply while a run is writing", () => {
    // `canTransition` lets APPLYING -> APPLYING through for idempotence, so on its own it
    // drew a black Apply beside "Applying" for the minutes a worker run takes.
    expect(sourceOf("app/routes/app.campaigns.$id.tsx")).toMatch(
      /const canApply = [^;]*canTransition\(state, "APPLYING"\) && !IN_FLIGHT\.has\(state\);/,
    );
  });

  it("is what the campaign page uses, and it polls the light endpoint, not the page", () => {
    expect(sourceOf("app/routes/app.campaigns.$id.tsx")).toMatch(/useRunPolling\(data\.campaignId, state\)/);
    // The page's loader plans the whole campaign (#812); polling it would be its own outage.
    const hook = sourceOf("app/components/campaign/useRunPolling.ts");
    expect(hook).toContain("/app/campaign-status?id=");
    expect(hook).not.toMatch(/setInterval\([^)]*revalidate/);
  });
});
