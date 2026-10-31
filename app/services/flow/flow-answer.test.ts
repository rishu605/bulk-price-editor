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

describe("the counts Flow's run log reads (#759)", () => {
  it("says variant for one and groups a large count", () => {
    expect(answerForRun({ ...ran, verified: 1 }, "Autumn sale", "applied").message).toBe(
      '"Autumn sale" applied: 1 variant, all verified.',
    );
    expect(answerForRun({ ...ran, verified: 3669 }, "Autumn sale", "ended").message).toBe(
      '"Autumn sale" ended: 3,669 variants, all verified.',
    );
  });

  it("groups a partial run's counts", () => {
    expect(answerForRun({ ...ran, clean: false, failed: 1, unverified: 1200 }, "Autumn sale", "applied").message).toContain(
      "1 failed and 1,200 unverified",
    );
  });
});

describe("what an end did with the prices edited outside Anchor (#794)", () => {
  it("counts the edits it kept, and says where they are listed", () => {
    expect(answerForRun({ ...ran, verified: 3, keptEdits: 1 }, "Autumn sale", "ended")).toEqual({
      status: 200,
      outcome: "done",
      message:
        '"Autumn sale" ended: 3 variants reverted and verified. 1 price edited outside Anchor was left as edited, not reverted. ' +
        "The campaign's Ledger tab lists it.",
    });
    expect(answerForRun({ ...ran, verified: 0, keptEdits: 2 }, "Autumn sale", "ended").message).toBe(
      '"Autumn sale" ended: 0 variants reverted and verified. 2 prices edited outside Anchor were left as edited, not reverted. ' +
        "The campaign's Ledger tab lists them.",
    );
  });

  it("says so on a partial end too", () => {
    const answer = answerForRun({ ...ran, clean: false, failed: 1, keptEdits: 1 }, "Autumn sale", "ended");
    expect(answer.outcome).toBe("partial");
    expect(answer.message).toContain("Resume it from the campaign page. 1 price edited outside Anchor was left as edited");
  });

  it("says edits are kept for an end handed to the worker, which finds them when it runs", () => {
    const queued = { ...ran, verified: 0, queued: true, messages: ["The worker is reverting it."] };
    expect(answerForRun(queued, "Autumn sale", "ended").message).toBe(
      '"Autumn sale": The worker is reverting it. Any price edited outside Anchor since the campaign set it is left as edited, not reverted.',
    );
    // A start has no edits to keep.
    expect(answerForRun(queued, "Autumn sale", "applied").message).toBe('"Autumn sale": The worker is reverting it.');
  });

  it("reads as before when there was no edit to keep", () => {
    expect(answerForRun({ ...ran, keptEdits: 0 }, "Autumn sale", "ended").message).toBe('"Autumn sale" ended: 4 variants, all verified.');
  });
});
