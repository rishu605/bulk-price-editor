/**
 * The checklist, and why it is derived rather than remembered.
 *
 * A merchant who clicked past a step has not captured baselines. A checklist that
 * tracked dismissals would tell them the app is ready to price when it cannot compute
 * anything — so every step is answered from what the shop has actually done.
 */

import { describe, expect, it } from "vitest";

import { onboarding, type OnboardingFacts } from "./steps";

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  hasBaselines: false,
  hasCampaign: false,
  hasPracticed: false,
  hasCleanRun: false,
  ...over,
});

describe("onboarding", () => {
  it("leads with syncing on a fresh install", () => {
    const state = onboarding(facts());
    expect(state.next?.id).toBe("sync");
    expect(state.complete).toBe(false);
  });

  it("moves to practice once baselines exist", () => {
    expect(onboarding(facts({ hasBaselines: true })).next?.id).toBe("practice");
  });

  it("skips practice for a merchant who already made a campaign", () => {
    // They stepped over it deliberately. Nagging them back is how a checklist becomes
    // noise, and noise is how the step that mattered gets ignored.
    const state = onboarding(facts({ hasBaselines: true, hasCampaign: true }));
    expect(state.next?.id).toBe("campaign");
  });

  it("still offers practice to someone who has baselines but no campaign", () => {
    expect(onboarding(facts({ hasBaselines: true, hasPracticed: false })).next?.id).toBe(
      "practice",
    );
  });

  it("retires only on a verified-clean run, not on a campaign existing", () => {
    // The goal is a campaign that finished with every row verified. A campaign that
    // exists, or one that half-applied, has not taught the merchant the thing.
    expect(onboarding(facts({ hasBaselines: true, hasCampaign: true })).complete).toBe(false);
    expect(onboarding(facts({ hasBaselines: true, hasCleanRun: true })).complete).toBe(true);
  });

  it("has nothing left to do once the first campaign has run cleanly", () => {
    const state = onboarding(
      facts({ hasBaselines: true, hasPracticed: true, hasCleanRun: true }),
    );
    expect(state.next).toBeNull();
    expect(state.steps.every((step) => step.done)).toBe(true);
  });

  it("drops the call to action from a completed step", () => {
    // A finished step with a button invites redoing it, and redoing the first one
    // recaptures baselines mid-sale — the single most destructive thing here.
    const step = onboarding(facts({ hasBaselines: true })).steps[0];
    expect(step.done).toBe(true);
    expect(step.cta).toBeUndefined();
    expect(step.href).toBeUndefined();
  });

  it("explains why each step exists, not just what to click", () => {
    for (const step of onboarding(facts()).steps) {
      expect(step.detail.length).toBeGreaterThan(80);
    }
    expect(onboarding(facts()).steps[0].detail).toContain("baseline");
  });
});
