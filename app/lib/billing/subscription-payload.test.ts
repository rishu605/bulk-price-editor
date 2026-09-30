/**
 * Reading a subscription webhook.
 *
 * The name-to-plan mapping is where this goes wrong, and when it does the shop silently
 * lands on free — which looks like a bug in gating rather than a bug here, so it is
 * worth being precise about.
 */

import { describe, expect, it } from "vitest";

import { parseSubscription, planFromName, staleSubscriptionUpdate } from "./subscription-payload";

describe("mapping a subscription name to a plan", () => {
  it("reads the plan out of the name Shopify echoes back", () => {
    expect(planFromName("Markets")).toBe("markets");
    expect(planFromName("Anchor Growth")).toBe("growth");
    expect(planFromName("Wholesale (annual)")).toBe("wholesale");
  });

  it("is case-insensitive, because the name is whatever was configured", () => {
    expect(planFromName("ANCHOR MARKETS")).toBe("markets");
  });

  it("takes the higher tier when a name mentions two", () => {
    // "Markets and Wholesale" should not resolve to Markets just because it appears
    // first in the string. Selling somebody Wholesale and gating B2B is a support
    // ticket that starts with "I paid for this".
    expect(planFromName("Markets and Wholesale")).toBe("wholesale");
  });

  it("falls back to free on a name it does not recognise", () => {
    // Deliberately forgiving in one direction only. A wrong upgrade gives away a paid
    // surface silently; a wrong downgrade the merchant notices within a minute.
    expect(planFromName("Enterprise Platinum")).toBe("free");
    expect(planFromName(undefined)).toBe("free");
  });
});

describe("reading the whole payload", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    app_subscription: {
      admin_graphql_api_id: "gid://shopify/AppSubscription/1",
      name: "Markets",
      status: "ACTIVE",
      created_at: "2026-08-01T00:00:00Z",
      trial_days: 14,
      ...over,
    },
  });

  it("carries the subscription id, status and plan", () => {
    expect(parseSubscription(payload())).toMatchObject({
      gid: "gid://shopify/AppSubscription/1",
      status: "ACTIVE",
      planId: "markets",
    });
  });

  it("works out when the trial ends", () => {
    const parsed = parseSubscription(payload());

    expect(parsed.trialEndsAt?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("has no trial end when there is no trial", () => {
    expect(parseSubscription(payload({ trial_days: 0 })).trialEndsAt).toBeNull();
  });

  it("reads a cancelled subscription as free whatever it was called", () => {
    // The name still says "Markets" on a cancelled subscription. Trusting it would keep
    // a merchant on a paid tier they have stopped paying for.
    expect(parseSubscription(payload({ status: "CANCELLED" })).planId).toBe("free");
    expect(parseSubscription(payload({ status: "EXPIRED" })).planId).toBe("free");
    expect(parseSubscription(payload({ status: "FROZEN" })).planId).toBe("free");
  });

  it("keeps an accepted-but-not-yet-active subscription on its plan", () => {
    // ACCEPTED is the state between the merchant approving the charge and Shopify
    // activating it. Treating it as free would gate a merchant out of the thing they
    // just paid for, for as long as that takes.
    expect(parseSubscription(payload({ status: "ACCEPTED" })).planId).toBe("markets");
  });

  it("survives a payload with nothing in it", () => {
    expect(parseSubscription({})).toMatchObject({ gid: null, planId: "free" });
    expect(parseSubscription(null)).toMatchObject({ planId: "free" });
  });
});

describe("an update older than what is stored (#709)", () => {
  const paying = { subscriptionGid: "gid://shopify/AppSubscription/2", subscriptionStatus: "ACTIVE" };

  it("ignores the old plan's cancellation arriving after the upgrade's activation", () => {
    expect(
      staleSubscriptionUpdate(paying, { gid: "gid://shopify/AppSubscription/1", status: "CANCELLED" }),
    ).toMatch(/CANCELLED for gid:\/\/shopify\/AppSubscription\/1, while the shop pays on .*\/2/);
  });

  it("ignores an upgrade that is still pending or was declined", () => {
    for (const status of ["PENDING", "DECLINED", "EXPIRED", "FROZEN"]) {
      expect(staleSubscriptionUpdate(paying, { gid: "gid://shopify/AppSubscription/3", status })).not.toBeNull();
    }
  });

  it("applies the cancellation of the subscription the shop is on", () => {
    expect(staleSubscriptionUpdate(paying, { gid: paying.subscriptionGid, status: "CANCELLED" })).toBeNull();
    expect(staleSubscriptionUpdate(paying, { gid: paying.subscriptionGid, status: "FROZEN" })).toBeNull();
  });

  it("applies a new subscription becoming active, whatever was stored", () => {
    expect(staleSubscriptionUpdate(paying, { gid: "gid://shopify/AppSubscription/3", status: "ACTIVE" })).toBeNull();
    const ended = { subscriptionGid: "gid://shopify/AppSubscription/1", subscriptionStatus: "CANCELLED" };
    expect(staleSubscriptionUpdate(ended, { gid: "gid://shopify/AppSubscription/2", status: "ACTIVE" })).toBeNull();
  });

  it("ignores an ACTIVE for a subscription that has already ended", () => {
    for (const storedStatus of ["CANCELLED", "DECLINED", "EXPIRED"]) {
      const ended = { subscriptionGid: "gid://shopify/AppSubscription/1", subscriptionStatus: storedStatus };
      expect(staleSubscriptionUpdate(ended, { gid: "gid://shopify/AppSubscription/1", status: "ACTIVE" })).not.toBeNull();
    }
  });

  it("lets a frozen subscription become active again, because unfreezing is real", () => {
    const frozen = { subscriptionGid: "gid://shopify/AppSubscription/1", subscriptionStatus: "FROZEN" };
    expect(staleSubscriptionUpdate(frozen, { gid: "gid://shopify/AppSubscription/1", status: "ACTIVE" })).toBeNull();
  });

  it("applies anything to a shop with no subscription on record, and anything without an id", () => {
    const none = { subscriptionGid: null, subscriptionStatus: null };
    expect(staleSubscriptionUpdate(none, { gid: "gid://shopify/AppSubscription/1", status: "CANCELLED" })).toBeNull();
    expect(staleSubscriptionUpdate(paying, { gid: null, status: "CANCELLED" })).toBeNull();
  });
});
