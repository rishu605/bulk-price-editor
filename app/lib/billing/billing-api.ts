/**
 * The paid plans, as the Shopify Billing API charges them (#860).
 *
 * The plan page used to send a merchant to Shopify's hosted App Pricing picker. No App
 * Pricing plans were ever set up -- the listing is on manual pricing -- so the picker was
 * Shopify's 404, and App Review paused the submission on it (1.2.1). The app now creates
 * the charge itself with `appSubscriptionCreate`, which is what manual pricing means, and
 * Shopify's approval screen is the checkout.
 *
 * Built from `plans.ts`, never written out a second time. The listing-parity test already
 * ties the listing's table to `plans.ts`; this ties what Shopify charges to it as well.
 *
 * Pure, so the mapping can be tested without a store: names, amounts and trial days are
 * where a mistake would charge the wrong price or put a paying merchant on Free.
 */

import { BillingInterval } from "@shopify/shopify-app-react-router/server";

import { planFromName } from "./subscription-payload";
import { PLAN_ORDER, PLANS, type PlanId } from "./plans";

/** The plans a merchant pays for. Free is the absence of a subscription, not a plan Shopify bills. */
export const PAID_PLANS: readonly PlanId[] = PLAN_ORDER.filter((id) => PLANS[id].priceMinor > 0);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The subscription's name on Shopify's side, which comes back on every subscription and
 * webhook. The plan's own name, so `planFromName` reads it back to the same tier -- a test
 * holds the round trip, because a name it could not read would land a paying shop on Free.
 */
export function billingPlanName(id: PlanId): string {
  return PLANS[id].name;
}

/**
 * The `billing` option for `shopifyApp`, one recurring plan per paid tier.
 *
 * The amount is the one place a price leaves integer minor units: the library takes a
 * decimal number, and it is derived here from the integer `priceMinor` rather than kept
 * anywhere as a float of its own (rule 7).
 */
export function billingConfig() {
  return Object.fromEntries(
    PAID_PLANS.map((id) => [
      billingPlanName(id),
      {
        lineItems: [
          {
            amount: PLANS[id].priceMinor / 100,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days as const,
          },
        ],
        trialDays: PLANS[id].trialDays,
      },
    ]),
  );
}

/**
 * Trial days for a new subscription: the plan's whole trial for a shop that has never had
 * one, what is left of a running trial when it changes plan, and none after that.
 *
 * Shopify starts a fresh trial with every subscription it is asked for. Without this,
 * switching plan -- or cancelling and coming back, or reinstalling -- restarted a 14-day
 * trial each time.
 */
export function trialDaysFor(id: PlanId, trialEndsAt: Date | null, now: Date = new Date()): number {
  const full = PLANS[id].trialDays;
  if (!trialEndsAt) return full;
  const left = Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS);
  return Math.max(0, Math.min(full, left));
}

/** One of `currentAppInstallation.activeSubscriptions`, as much of it as the app reads. */
export interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  trialDays?: number | null;
  createdAt?: string | null;
}

/** What the installation is paying on, read from Shopify rather than from a webhook. */
export interface CurrentSubscription {
  gid: string;
  status: string;
  planId: PlanId;
  trialEndsAt: Date | null;
}

/**
 * The subscription a shop's tier follows, from Shopify's own list of active ones.
 *
 * Normally one. During an upgrade Shopify can briefly list the old and the new together;
 * the newest is the one the merchant just approved. Null when nothing is active: the shop
 * is on Free.
 */
export function currentSubscription(active: readonly ActiveSubscription[]): CurrentSubscription | null {
  const newest = [...active].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))[0];
  if (!newest) return null;

  const created = Date.parse(newest.createdAt ?? "");
  return {
    gid: newest.id,
    status: newest.status.toUpperCase(),
    planId: planFromName(newest.name),
    trialEndsAt:
      newest.trialDays && Number.isFinite(created) ? new Date(created + newest.trialDays * DAY_MS) : null,
  };
}

/**
 * Where Shopify sends the merchant after they approve or decline: back to this page,
 * inside their admin.
 *
 * Without it the library returns them to the app's home, and a merchant who has just paid
 * for Markets lands somewhere that says nothing about it.
 */
export function planReturnUrl(shopDomain: string, handle: string | null): string | undefined {
  if (!handle || !/^[a-z0-9][a-z0-9-]*$/.test(handle)) return undefined;
  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/apps/${handle}/app/settings/plan`;
}
