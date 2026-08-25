/**
 * Reading a shop's plan.
 *
 * The cases that matter are the ones where a subscription is not simply active: a
 * cancelled card, a dev store, a plan tier that outlives the subscription behind it.
 * Getting those wrong either gates a paying merchant or gives the app away.
 */

import { describe, expect, it } from "vitest";

import { billingFrom } from "./billing.server";

const shop = (over: Record<string, unknown> = {}) => ({
  planTier: "MARKETS" as const,
  subscriptionStatus: "ACTIVE",
  trialEndsAt: null,
  developerStore: false,
  ...over,
});

describe("working out which plan a shop is on", () => {
  it("reads an active subscription as its tier", () => {
    expect(billingFrom(shop()).plan.id).toBe("markets");
  });

  it("treats a cancelled subscription as free for what can be started", () => {
    // Only for starting. Nothing here reaches the revert path, which is the whole of
    // E8 and is asserted against a real engine in the chaos suite.
    expect(billingFrom(shop({ subscriptionStatus: "CANCELLED" })).plan.id).toBe("free");
    expect(billingFrom(shop({ subscriptionStatus: "FROZEN" })).plan.id).toBe("free");
  });

  it("keeps an accepted subscription on its tier", () => {
    // The gap between a merchant approving the charge and Shopify activating it. Gating
    // them out of what they just bought, for however long that takes, is the wrong side
    // to err on.
    expect(billingFrom(shop({ subscriptionStatus: "ACCEPTED" })).plan.id).toBe("markets");
  });

  it("gives a development store everything, and charges nothing", () => {
    const billing = billingFrom(shop({ developerStore: true, planTier: "FREE" }));

    expect(billing.plan.id).toBe("wholesale");
    expect(billing.exempt).toBe(true);
  });

  it("reads a shop with no subscription row yet as its tier", () => {
    // A shop installed before billing existed has a tier and no subscription. Reading
    // that as cancelled would downgrade every existing merchant on deploy.
    expect(billingFrom(shop({ subscriptionStatus: null })).plan.id).toBe("markets");
  });

  it("reports a trial that has not ended", () => {
    const future = new Date(Date.now() + 5 * 86_400_000);

    expect(billingFrom(shop({ trialEndsAt: future }))).toMatchObject({ trialing: true });
  });

  it("does not report a trial that has passed", () => {
    const past = new Date(Date.now() - 86_400_000);

    expect(billingFrom(shop({ trialEndsAt: past })).trialing).toBe(false);
  });

  it("falls back to free for a shop we know nothing about", () => {
    expect(billingFrom(null).plan.id).toBe("free");
  });
});
