/**
 * A refusal that renders as a success is worse than no guard at all: the merchant is told
 * their campaign was applied, and it was not.
 *
 * `refused` sat on `RunOutcome` for the plan gate and was read by nobody, so **every**
 * refusal rendered as "Applied 0 variants, all verified" — a green tick over a run that
 * never happened. Deferral had the same shape and had already been special-cased once.
 *
 * This used to be asserted by grepping the campaign route for the order of two branches,
 * with a note saying the alternative was mounting the whole route to check a ternary.
 * Moving the sentence out of the route removed that constraint: it is a pure function now,
 * so the three outcomes can be checked by calling it.
 */

import { describe, expect, it } from "vitest";

import { runResponse } from "./run-response";

/** Clean, nothing written, no failures — the shape all three outcomes share. */
const quiet = {
  clean: true,
  verified: 0,
  failed: 0,
  unverified: 0,
  messages: ["Another worker is applying this campaign."],
};

describe("a run that was refused", () => {
  const refused = runResponse(
    { ...quiet, refused: "This campaign covers 180,000 variants — schedule it instead." },
    "Applied",
  );

  it("says why, rather than reporting a successful run of nothing", () => {
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("180,000");
    expect(refused.message).not.toContain("all verified");
  });

  it("is a warning and not a failure", () => {
    // Red would send a merchant hunting for a fault in a system that behaved exactly as
    // designed. Nothing broke; the run was declined.
    expect(refused.tone).toBe("warning");
  });

  it("wins over the outcome message even though the outcome says clean", () => {
    // The whole bug: `clean` is true and `verified` is 0, so the generic branch is
    // perfectly happy to describe a refusal as a success.
    expect(quiet.clean).toBe(true);
    expect(refused.message).not.toContain("Applied 0 variants");
  });
});

describe("a run that deferred", () => {
  it("reports what the other worker is doing, as good news", () => {
    // Something *is* writing the merchant's prices right now, so this is not a failure —
    // but "Applied 0 variants, all verified" would be technically true and completely
    // misleading about what is happening to their storefront.
    const deferred = runResponse({ ...quiet, deferredTo: "run_123" }, "Applied");

    expect(deferred.ok).toBe(true);
    expect(deferred.message).toBe("Another worker is applying this campaign.");
  });

  it("survives an outcome that deferred without saying anything", () => {
    const deferred = runResponse({ ...quiet, messages: [], deferredTo: "run_123" }, "Applied");

    expect(deferred.message).toBe("");
  });
});

describe("a run that actually ran", () => {
  it("counts what it verified, in the verb the caller used", () => {
    const clean = runResponse(
      { clean: true, verified: 412, failed: 0, unverified: 0, messages: [] },
      "Reverted",
    );

    expect(clean).toMatchObject({ ok: true, message: "Reverted 412 variants, all verified." });
    expect(clean.tone).toBeUndefined();
  });

  it("names the failures and points at resume when it was partial", () => {
    // A partial run is the honest answer, not an embarrassment — and the next action has
    // to be in the sentence, because a merchant who cannot see what to do next assumes
    // there is nothing to do.
    const partial = runResponse(
      { clean: false, verified: 300, failed: 7, unverified: 2, messages: ["Variant 9: throttled"] },
      "Applied",
    );

    expect(partial.ok).toBe(false);
    expect(partial.message).toContain("7 failures");
    expect(partial.message).toContain("2 unverified");
    expect(partial.message).toContain("resume");
    expect(partial.details).toEqual(["Variant 9: throttled"]);
  });
});
