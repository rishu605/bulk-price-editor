/**
 * When a page waiting on a run reloads itself (#790).
 *
 * The hook's timers are wiring; the decision is this function, and the decision is where
 * a page either sits on "Applying" for ever or reloads itself in a loop.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";
import { etaFrom, finished, IN_FLIGHT, phaseFrom, RUN_DONE } from "./useRunPolling";

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

  it("shows the latest answer's time left only while the page is mid-run (#820)", () => {
    expect(etaFrom("APPLYING", { eta: "about 4 minutes left" })).toBe("about 4 minutes left");
    expect(etaFrom("REVERTING", { eta: "under a minute left" })).toBe("under a minute left");
    // Before the first answer, and where the run cannot say.
    expect(etaFrom("APPLYING", undefined)).toBeNull();
    expect(etaFrom("APPLYING", { eta: null })).toBeNull();
    // Reloaded into the finished campaign before a poll heard it end: the fetcher still holds
    // the estimate from before, and it is not shown under "Active".
    for (const state of ["ACTIVE", "PARTIAL", "COMPLETED", "DRAFT"]) {
      expect(etaFrom(state, { eta: "about 4 minutes left" }), state).toBeNull();
    }
  });

  it("asks the status route for the estimate and the phase, which asks the run only while one writes (#820, #808)", () => {
    expect(sourceOf("app/routes/app.campaigns.$id.tsx")).toMatch(/const \{ eta, phase, done \} = useRunPolling\(data\.campaignId, state\)/);
    const status = sourceOf("app/routes/app.campaign-status.tsx");
    expect(status).toMatch(
      /const progress = campaign && IN_FLIGHT\.has\(campaign\.status\) \? await runProgressOf\(campaign\.shopId, id\) : null/,
    );
    expect(status).toContain("eta: progress?.eta ?? null");
    expect(status).toContain("phase: progress?.phase ?? null");
  });

  it("shows the latest answer's phase only while the page is mid-run (#808)", () => {
    expect(phaseFrom("APPLYING", { phase: "Writing 2 of 60 prices" })).toBe("Writing 2 of 60 prices");
    expect(phaseFrom("REVERTING", { phase: "Queued" })).toBe("Queued");
    expect(phaseFrom("APPLYING", undefined)).toBeNull();
    for (const state of ["ACTIVE", "PARTIAL", "COMPLETED"]) expect(phaseFrom(state, { phase: "Verifying" }), state).toBeNull();
  });

  it("says Done once the run it watched has finished cleanly, in place of the answer it was given when it was queued (#808)", () => {
    expect(RUN_DONE).toMatchObject({ ok: true });
    expect(RUN_DONE.message).toMatch(/^Done\. The background worker has finished/);
    expect(sourceOf("app/routes/app.campaigns.$id.tsx")).toContain("<ResultBanner result={done ? RUN_DONE : fetcher.data} />");
    // Not after one that stopped part-way: the page's Partial banner says that.
    expect(sourceOf("app/components/campaign/useRunPolling.ts")).toContain('new Set(["ACTIVE", "COMPLETED"])');
  });

  it("is what the campaign page uses, and it polls the light endpoint, not the page", () => {
    expect(sourceOf("app/routes/app.campaigns.$id.tsx")).toMatch(/useRunPolling\(data\.campaignId, state\)/);
    // The page's loader plans the whole campaign (#812); polling it would be its own outage.
    const hook = sourceOf("app/components/campaign/useRunPolling.ts");
    expect(hook).toContain("/app/campaign-status?id=");
    expect(hook).not.toMatch(/setInterval\([^)]*revalidate/);
  });
});
