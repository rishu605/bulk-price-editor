import { describe, expect, it } from "vitest";

import { describeState } from "../lifecycle/transitions";
import { compose } from "../notifications/templates";
import { queuedRefusal, queuedVerb, QUEUED_REFUSED_KEY, withoutQueuedRefused, withQueuedRefused } from "./queued-refusal";
import { copiedSchedule } from "./schedule-blob";

const at = new Date("2026-10-15T10:00:00Z");
const refusal = { verb: "apply" as const, reason: "A guardrail stopped this run before anything was written." };

describe("a queued run refused before it wrote (#1046)", () => {
  it("is kept beside the definition and read back, and cleared without touching the rest", () => {
    const schedule = withQueuedRefused({ kind: "manual", rounding: "x" }, refusal, at);
    expect(queuedRefusal(schedule)).toEqual(refusal);
    expect(withoutQueuedRefused(schedule)).toEqual({ kind: "manual", rounding: "x" });
    expect(withoutQueuedRefused({ kind: "manual" }), "nothing to clear is not a write").toBeNull();
  });

  it("is not carried to a copy, which never ran", () => {
    expect(copiedSchedule(withQueuedRefused({ kind: "manual" }, refusal, at))).not.toHaveProperty(QUEUED_REFUSED_KEY);
  });

  it("ignores a stored value it does not understand", () => {
    expect(queuedRefusal({ [QUEUED_REFUSED_KEY]: { verb: "explode", reason: "x" } })).toBeNull();
    expect(queuedRefusal({ [QUEUED_REFUSED_KEY]: { verb: "apply" } })).toBeNull();
    expect(queuedRefusal(null)).toBeNull();
  });

  it("names what was asked", () => {
    expect(queuedVerb({})).toBe("apply");
    expect(queuedVerb({ resume: true })).toBe("resume");
    expect(queuedVerb({ revert: true, resume: true })).toBe("revert");
  });

  it("is said on the Status card over the state it left, but not while a later run holds the claim", () => {
    const draft = describeState("DRAFT", { queuedRefused: refusal });
    expect(draft.label).toBe("Draft — couldn't apply");
    expect(draft.tone).toBe("warning");
    expect(draft.explanation).toBe(
      "Its apply was handed to the background worker and could not run: A guardrail stopped this run before anything was written. " +
        "It wrote nothing. " +
        describeState("DRAFT").explanation,
    );
    expect(draft.nextAction).toEqual(describeState("DRAFT").nextAction);
    expect(describeState("ACTIVE", { queuedRefused: { verb: "revert", reason: "x" } }).label).toBe("Active — couldn't revert");
    expect(describeState("APPLYING", { queuedRefused: refusal }).label).toBe("Applying");
  });

  it("is emailed as a run that did not happen, and a revert says the sale is still live", () => {
    const base = { kind: "run-failed" as const, campaignId: "c1", campaignName: "Summer", counts: { verified: 0, failed: 0, unverified: 0, skipped: 0, clamped: 0 } };
    const applied = compose({ ...base, queued: "apply", reasons: [refusal.reason] });
    expect(applied.subject).toBe('"Summer" was not applied');
    expect(applied.text).toContain(`The background worker was handed "Summer"'s apply, and it could not run. It wrote nothing.`);
    expect(applied.text).toContain(refusal.reason);
    expect(applied.text).toContain("Once the cause is fixed, apply the campaign again from its page.");
    const reverted = compose({ ...base, queued: "revert", revert: true });
    expect(reverted.subject).toBe('"Summer" was not reverted');
    expect(reverted.text).toContain("so the campaign's prices are still on your storefront.");
  });
});
