import { describe, expect, it } from "vitest";

import { ALL_STATES, pricesMayBeLive } from "../lifecycle/transitions";
import {
  BREACH_POLICY_LABELS,
  breachPolicyAtApply,
  breachPolicyDetail,
  breachPolicyFor,
  breachPolicyOfDraft,
  startsKeepingPolicy,
} from "./breach-policy";

describe("which floor-breach policy a campaign runs with (#789)", () => {
  it("follows the store's setting until the campaign has prices up", () => {
    // The live repro: "QA · scheduled", made under Clamp, previewed clamped after Block was saved.
    for (const state of ["DRAFT", "SCHEDULED", "COMPLETED", "CANCELLED"] as const) {
      expect(breachPolicyFor(state, "clamp", "block"), state).toEqual({ policy: "block", kept: false, store: "block" });
    }
  });

  it("keeps the one it started with while its prices may be on the storefront", () => {
    for (const state of ["APPLYING", "ACTIVE", "HELD", "PARTIAL", "REVERTING"] as const) {
      expect(breachPolicyFor(state, "clamp", "block"), state).toEqual({ policy: "clamp", kept: true, store: "block" });
    }
  });

  it("keeps its own in exactly the states whose prices may be live", () => {
    // One rule, so a state added to the machine cannot be one answer here and another there.
    for (const state of ALL_STATES) expect(breachPolicyFor(state, "skip", "block").kept, state).toBe(pricesMayBeLive(state));
  });

  it("starts keeping it on the move into a state with prices live, and only that move", () => {
    expect(startsKeepingPolicy("DRAFT", "APPLYING")).toBe(true);
    expect(startsKeepingPolicy("SCHEDULED", "APPLYING")).toBe(true);
    expect(startsKeepingPolicy("COMPLETED", "APPLYING")).toBe(true);
    // A resume, a re-apply over a held edit, an apply of an active one: already running.
    expect(startsKeepingPolicy("PARTIAL", "APPLYING")).toBe(false);
    expect(startsKeepingPolicy("HELD", "APPLYING")).toBe(false);
    expect(startsKeepingPolicy("ACTIVE", "APPLYING")).toBe(false);
    expect(startsKeepingPolicy("ACTIVE", "REVERTING")).toBe(false);
    expect(startsKeepingPolicy("SCHEDULED", "DRAFT")).toBe(false);
    expect(startsKeepingPolicy("APPLYING", "ACTIVE")).toBe(false);
  });
});

describe("how it is said", () => {
  it("names each policy in the Settings field's words", () => {
    expect(BREACH_POLICY_LABELS).toEqual({
      clamp: "Clamp it to the floor and carry on",
      skip: "Skip that variant, price the rest",
      block: "Block the whole campaign",
    });
  });

  it("says whose it is on the campaign page", () => {
    expect(breachPolicyDetail({ policy: "block", kept: false, store: "block" })).toBe(
      "The store's setting, which this campaign follows until it starts. From then it keeps it until it ends.",
    );
    expect(breachPolicyDetail({ policy: "clamp", kept: true, store: "clamp" })).toBe(
      "The one it started with, which it keeps until it ends, whatever Settings says.",
    );
    expect(breachPolicyDetail({ policy: "clamp", kept: true, store: "block" })).toBe(
      "The one it started with, which it keeps until it ends. Settings now says “Block the whole campaign”, " +
        "for new campaigns and anything not yet started.",
    );
  });

  it("restates it in the Apply dialog", () => {
    expect(breachPolicyAtApply({ policy: "block", kept: false, store: "block" })).toBe(
      "Block the whole campaign: the store's setting, which this campaign keeps until it ends",
    );
    expect(breachPolicyAtApply({ policy: "skip", kept: true, store: "skip" })).toBe("Skip that variant, price the rest: the one it started with");
    expect(breachPolicyAtApply({ policy: "clamp", kept: true, store: "skip" })).toBe(
      "Clamp it to the floor and carry on: the one it started with. Settings now says “Skip that variant, price the rest”, which it does not follow",
    );
  });
});

describe("a policy the campaign chose itself (#816, D30)", () => {
  it("is the campaign's in every state, whatever Settings says", () => {
    for (const state of ALL_STATES) {
      expect(breachPolicyFor(state, "clamp", "clamp", "block"), state).toEqual({
        policy: "block",
        kept: pricesMayBeLive(state),
        store: "clamp",
        own: true,
      });
    }
  });

  it("leaves a campaign that chose none following the store until it starts, as D21 says", () => {
    expect(breachPolicyFor("DRAFT", "clamp", "block", undefined)).toEqual({ policy: "block", kept: false, store: "block" });
    expect(breachPolicyFor("ACTIVE", "clamp", "block", undefined)).toEqual({ policy: "clamp", kept: true, store: "block" });
  });

  it("is said as its own choice on the page, in the Apply dialog and in the editor's preview", () => {
    const own = breachPolicyFor("DRAFT", "block", "clamp", "block");
    expect(breachPolicyDetail(own)).toBe(
      "This campaign's own choice, which it keeps whatever Settings says. Settings now says “Clamp it to the floor and carry on”.",
    );
    expect(breachPolicyAtApply(own)).toBe(
      "Block the whole campaign: this campaign's own choice. Settings says “Clamp it to the floor and carry on”, which it does not follow",
    );
    expect(breachPolicyAtApply(breachPolicyFor("ACTIVE", "skip", "skip", "skip"))).toBe("Skip that variant, price the rest: this campaign's own choice");
    expect(breachPolicyOfDraft(undefined, "skip")).toBe("Skip that variant, price the rest: the store's setting, which it follows until it starts");
    expect(breachPolicyOfDraft("clamp", "clamp")).toBe("Clamp it to the floor and carry on: this campaign's own choice");
  });
});
