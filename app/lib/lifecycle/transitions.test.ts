import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ALL_STATES,
  canTransition,
  describeState,
  isTerminal,
  needsAttention,
  pricesMayBeLive,
  type CampaignState,
} from "./transitions";

const anyState = () => fc.constantFrom<CampaignState>(...ALL_STATES);

describe("legal transitions", () => {
  it("walks the documented happy path", () => {
    const path: CampaignState[] = [
      "DRAFT",
      "SCHEDULED",
      "APPLYING",
      "ACTIVE",
      "REVERTING",
      "COMPLETED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("lets a partial run resume", () => {
    // The acceptance criterion this whole state exists for: a partial must be
    // recoverable, not a dead end.
    expect(canTransition("PARTIAL", "APPLYING")).toBe(true);
    expect(canTransition("PARTIAL", "REVERTING")).toBe(true);
  });

  it("lets a held campaign resolve either way", () => {
    expect(canTransition("HELD", "APPLYING")).toBe(true);
    expect(canTransition("HELD", "REVERTING")).toBe(true);
  });

  it("re-arms a completed campaign for the next occurrence", () => {
    // Recurrence reuses the campaign rather than cloning it, so the run history stays
    // in one place.
    expect(canTransition("COMPLETED", "SCHEDULED")).toBe(true);
  });

  it("treats cancelled as the only dead end", () => {
    expect(isTerminal("CANCELLED")).toBe(true);
    for (const state of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(isTerminal(state), state).toBe(false);
    }
  });

  it("refuses to resurrect a cancelled campaign", () => {
    for (const to of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(canTransition("CANCELLED", to), to).toBe(false);
    }
  });

  it("never skips straight from draft to active", () => {
    // Going ACTIVE without passing through APPLYING would mean claiming prices are
    // live and verified without ever having written any.
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransition("SCHEDULED", "ACTIVE")).toBe(false);
  });

  it("allows cancelling from anywhere that is still alive", () => {
    for (const state of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(canTransition(state, "CANCELLED"), state).toBe(true);
    }
  });

  it("is idempotent: any state may transition to itself", () => {
    // A redelivered tick asking for a state we already hold must be a no-op, not a
    // failure. Without this, every duplicate webhook or double tick raises an error.
    fc.assert(
      fc.property(anyState(), (state) => {
        expect(canTransition(state, state)).toBe(true);
      }),
    );
  });

  it("never throws, for any pair of states", () => {
    fc.assert(
      fc.property(anyState(), anyState(), (from, to) => {
        expect(() => canTransition(from, to)).not.toThrow();
        expect(typeof canTransition(from, to)).toBe("boolean");
      }),
    );
  });
});

describe("what the merchant is told", () => {
  it("describes every state without falling through", () => {
    for (const state of ALL_STATES) {
      const described = describeState(state);
      expect(described.label, state).toBeTruthy();
      expect(described.explanation.length, state).toBeGreaterThan(20);
    }
  });

  it("gives the two attention states a way out", () => {
    // A partial with no resume, or a held with no link to the drift queue, is a dead
    // end dressed up as information.
    expect(describeState("PARTIAL").nextAction?.intent).toBe("resume");
    expect(describeState("HELD").nextAction?.intent).toBe("drift");
  });

  it("does not dress up partial or held as success", () => {
    expect(describeState("PARTIAL").tone).toBe("critical");
    expect(describeState("HELD").tone).toBe("warning");
    expect(needsAttention("PARTIAL")).toBe(true);
    expect(needsAttention("HELD")).toBe(true);
  });

  it("reserves success for the state where every row was verified", () => {
    const successes = ALL_STATES.filter((s) => describeState(s).tone === "success");
    expect(successes).toEqual(["ACTIVE"]);
  });

  it("knows where prices may still be live", () => {
    // Drives the "your prices are safe" wording on the error screen and the warning
    // before deleting a campaign.
    expect(pricesMayBeLive("PARTIAL")).toBe(true);
    expect(pricesMayBeLive("ACTIVE")).toBe(true);
    expect(pricesMayBeLive("HELD")).toBe(true);
    expect(pricesMayBeLive("DRAFT")).toBe(false);
    expect(pricesMayBeLive("COMPLETED")).toBe(false);
    expect(pricesMayBeLive("CANCELLED")).toBe(false);
  });
});
