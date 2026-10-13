/**
 * What Shopify is asked to charge, and how its answer is read back (#860).
 *
 * The plan page used to send merchants to Shopify's hosted App Pricing picker, which was a
 * 404 because no App Pricing plans existed; App Review paused the submission on it. The
 * app now charges through the Billing API, and these are the places that would quietly
 * charge the wrong price or put a paying shop on Free.
 */

import { describe, expect, it } from "vitest";

import {
  billingConfig,
  billingPlanName,
  currentSubscription,
  PAID_PLANS,
  planReturnUrl,
  trialDaysFor,
} from "./billing-api";
import { PLANS } from "./plans";
import { planFromName } from "./subscription-payload";

const DAY = 86_400_000;

describe("the plans Shopify charges", () => {
  const config = billingConfig();

  it("are the three paid tiers; Free is no subscription at all", () => {
    expect(PAID_PLANS).toEqual(["growth", "markets", "wholesale"]);
    expect(Object.keys(config)).toEqual(["Growth", "Markets", "Wholesale"]);
  });

  it.each(PAID_PLANS)("charges for %s what plans.ts says, every 30 days, in USD", (id) => {
    const [item] = config[billingPlanName(id)].lineItems;
    expect(Math.round(item.amount * 100), `${id}'s price`).toBe(PLANS[id].priceMinor);
    expect(item.currencyCode).toBe("USD");
    expect(item.interval).toBe("EVERY_30_DAYS");
    expect(config[billingPlanName(id)].trialDays).toBe(PLANS[id].trialDays);
  });

  it.each(PAID_PLANS)("names %s so the subscription Shopify sends back reads as the same tier", (id) => {
    // The name comes back on every subscription and webhook. One `planFromName` cannot read
    // lands a paying shop on Free.
    expect(planFromName(billingPlanName(id))).toBe(id);
  });
});

describe("trial days for a new subscription", () => {
  const now = new Date("2026-10-13T12:00:00Z");

  it("are the whole trial for a shop that has never had one", () => {
    expect(trialDaysFor("markets", null, now)).toBe(14);
  });

  it("are what is left when a shop changes plan mid-trial", () => {
    expect(trialDaysFor("wholesale", new Date(now.getTime() + 3.2 * DAY), now)).toBe(4);
  });

  it("are none once the trial has ended -- switching plan, cancelling or reinstalling does not start another", () => {
    expect(trialDaysFor("growth", new Date(now.getTime() - DAY), now)).toBe(0);
  });

  it("never exceed the plan's own trial", () => {
    expect(trialDaysFor("growth", new Date(now.getTime() + 40 * DAY), now)).toBe(14);
  });
});

describe("reading what the shop pays on from Shopify", () => {
  const sub = (id: string, name: string, createdAt: string, trialDays = 0) => ({
    id: `gid://shopify/AppSubscription/${id}`,
    name,
    status: "ACTIVE",
    trialDays,
    createdAt,
  });

  it("is Free when nothing is active", () => {
    expect(currentSubscription([])).toBeNull();
  });

  it("reads the tier, the status and when the trial ends", () => {
    expect(currentSubscription([sub("1", "Markets", "2026-10-01T00:00:00Z", 14)])).toEqual({
      gid: "gid://shopify/AppSubscription/1",
      status: "ACTIVE",
      planId: "markets",
      trialEndsAt: new Date("2026-10-15T00:00:00Z"),
    });
  });

  it("takes the newest when an upgrade briefly lists the old plan beside the new", () => {
    const found = currentSubscription([
      sub("1", "Growth", "2026-09-01T00:00:00Z"),
      sub("2", "Wholesale", "2026-10-12T00:00:00Z"),
    ]);
    expect(found?.planId).toBe("wholesale");
    expect(found?.trialEndsAt).toBeNull();
  });
});

describe("where Shopify returns the merchant", () => {
  it("is this page, inside their admin", () => {
    expect(planReturnUrl("boltify-apps.myshopify.com", "bulk-price-editor-98")).toBe(
      "https://admin.shopify.com/store/boltify-apps/apps/bulk-price-editor-98/app/settings/plan",
    );
  });

  it("is left to the library when the handle is unknown or not a handle", () => {
    expect(planReturnUrl("boltify-apps.myshopify.com", null)).toBeUndefined();
    expect(planReturnUrl("boltify-apps.myshopify.com", "../evil")).toBeUndefined();
  });
});
