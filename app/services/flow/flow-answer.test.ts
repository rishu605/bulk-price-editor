/**
 * What Shopify Flow is told (#773).
 *
 * Flow shows a 4xx as a failure and does not resend it; it resends a 5xx for up to 36
 * hours. So a refusal must be a 4xx -- it used to be a 200, a green run log for nothing
 * -- and only a failure that clears on its own may be a 5xx.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.server", () => ({ default: {} }));

import { AppError } from "../../lib/errors/app-error";
import type { RunOutcome } from "../campaigns/types";
import { answerForError, answerForRun } from "./flow-answer.server";

const ran: RunOutcome = { runId: "r1", planned: 4, verified: 4, failed: 0, unverified: 0, clean: true, messages: [] };

describe("a run's answer", () => {
  it("is 200 when it ran clean", () => {
    expect(answerForRun(ran, "Autumn sale", "applied")).toMatchObject({ status: 200, outcome: "done" });
  });

  it("is 200 when it was handed to the worker, saying so", () => {
    const answer = answerForRun({ ...ran, verified: 0, queued: true, messages: ["The worker is applying it."] }, "Autumn sale", "applied");
    expect(answer).toMatchObject({ status: 200, outcome: "queued" });
    expect(answer.message).toContain("The worker is applying it.");
  });

  it("is a 4xx naming the campaign and the reason when it was refused", () => {
    const answer = answerForRun({ ...ran, verified: 0, refused: "This is a practice campaign." }, "Autumn sale", "applied");
    expect(answer.status).toBe(422);
    expect(answer.message).toBe('"Autumn sale" was not applied: This is a practice campaign.');
  });

  it("is a 503 when the refusal clears on its own, so Flow resends it", () => {
    const answer = answerForRun({ ...ran, verified: 0, refused: "A variant change is being written.", transient: true }, "Autumn sale", "applied");
    expect(answer).toMatchObject({ status: 503, outcome: "retry" });
  });

  it("is 200 when another run is already doing exactly this", () => {
    expect(answerForRun({ ...ran, verified: 0, deferredTo: "run-2" }, "Autumn sale", "ended")).toMatchObject({
      status: 200,
      outcome: "done",
    });
  });

  it("is 200 for a partial run, which is visible and resumable in Anchor -- not a 5xx that restarts it", () => {
    expect(answerForRun({ ...ran, clean: false, failed: 1 }, "Autumn sale", "applied")).toMatchObject({
      status: 200,
      outcome: "partial",
    });
  });
});

describe("a throw's answer", () => {
  const error = (code: ConstructorParameters<typeof AppError>[0]["code"]) =>
    answerForError(new AppError({ code, userMessage: `${code} happened.` }), '"Autumn sale" was not applied');

  it("resends only what clears on its own", () => {
    expect(error("SHOPIFY_THROTTLED").status).toBe(429);
    expect(error("SHOPIFY_UNAVAILABLE").status).toBe(503);
    expect(error("DB_UNAVAILABLE").status).toBe(503);
  });

  it("answers anything that would fail the same way again with a 4xx", () => {
    expect(error("VALIDATION").status).toBe(400);
    expect(error("NOT_FOUND").status).toBe(404);
    expect(error("GUARDRAIL_BLOCKED").status).toBe(422);
    // Unclassified: 36 hours of identical failures would be worse than one visible one.
    expect(error("UNKNOWN").status).toBe(422);
    expect(answerForError(new Error("Campaign blocked by a guardrail on gid://x: below cost"), "x").status).toBe(422);
  });

  it("names what failed and why", () => {
    expect(error("VALIDATION").message).toBe('"Autumn sale" was not applied: VALIDATION happened.');
  });
});
