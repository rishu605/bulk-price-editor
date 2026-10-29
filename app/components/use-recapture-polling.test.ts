/**
 * When the recapture page following a recapture in the worker reloads itself (#1105).
 *
 * The hook's timers are wiring; the decision is `recaptureEnded`, and the decision is where a
 * page either says "running" for ever or reloads itself in a loop.
 */

import { describe, expect, it } from "vitest";

import type { RecaptureState } from "../lib/baselines/recapture-progress";
import { sourceOf } from "../lib/testing/source";
import { recaptureEnded } from "./useRecapturePolling";

const state = (id: string, running: boolean): RecaptureState => ({
  id,
  scope: 10,
  running,
  phase: running ? "ladders" : null,
  text: running ? "Reading wholesale quantity breaks from Shopify" : null,
  outcome: running ? null : "Recaptured 10 baselines across 10 variants.",
  partial: false,
  failure: null,
});

describe("a page following a recapture", () => {
  it("reloads once the recapture it is following has ended", () => {
    expect(recaptureEnded("rc_1", state("rc_1", false), true)).toBe(true);
  });

  it("keeps following while it runs, and while there is no answer yet", () => {
    expect(recaptureEnded("rc_1", state("rc_1", true), true)).toBe(false);
    expect(recaptureEnded("rc_1", null, true)).toBe(false);
    expect(recaptureEnded("rc_1", undefined, true)).toBe(false);
  });

  it("ignores an answer it did not ask for, or one about another recapture", () => {
    // The fetcher still holds the "finished" it heard about the previous recapture.
    expect(recaptureEnded("rc_2", state("rc_1", false), true)).toBe(false);
    expect(recaptureEnded("rc_1", state("rc_1", false), false)).toBe(false);
  });

  it("has nothing to follow on a page whose recapture is not running", () => {
    expect(recaptureEnded(null, state("rc_1", false), true)).toBe(false);
  });
});

describe("the recapture page, following one", () => {
  const PAGE = sourceOf("app/routes/app.prices.baselines.recapture.tsx");
  const HOOK = sourceOf("app/components/useRecapturePolling.ts");

  it("follows the recapture it was handed, or the one it found running", () => {
    expect(PAGE).toMatch(/useRecapturePolling\(background\)/);
    expect(PAGE).toContain('next.set("recapture", handedOff)');
    expect(PAGE).toContain('recaptureOnPage(shop.id, url.searchParams.get("recapture"))');
  });

  it("polls the light endpoint, not its own loader, which plans the whole scope", () => {
    expect(HOOK).toContain("/app/recapture-status?id=");
    expect(HOOK).not.toMatch(/setInterval\([^)]*revalidate/);
  });
});
