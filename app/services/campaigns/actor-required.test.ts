/**
 * Who moved a campaign is never left to a default (#746).
 *
 * A transition with no actor was recorded as "system", which Activity shows as the
 * Scheduler, so every Apply and Revert pressed by hand -- and every Flow start and end --
 * read as the Scheduler's doing. The actor is now required on every transition and every
 * run, so leaving it out is a type error rather than a quiet misattribution.
 *
 * These lines are the guard: if `actor` ever becomes optional again, the expected errors
 * disappear and `tsc` fails on the unused `@ts-expect-error`.
 */

import { describe, expect, it } from "vitest";

import type { TransitionOptions } from "./lifecycle.server";
import type { RunOptions } from "./run.server";
import type { QueuedRunOptions } from "./queued-run.server";

describe("who moved a campaign", () => {
  it("is required on every transition, run and queued run", () => {
    // @ts-expect-error -- a transition without an actor read as the Scheduler.
    const transition: TransitionOptions = { reason: "apply requested" };
    // @ts-expect-error -- and so did every run that did not say who asked for it.
    const run: RunOptions = { revert: true };
    // @ts-expect-error -- a run handed to the worker carries its actor with it.
    const queued: QueuedRunOptions = { revert: false };
    expect([transition, run, queued]).toHaveLength(3);
  });
});
