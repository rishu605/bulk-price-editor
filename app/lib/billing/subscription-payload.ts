/**
 * Reading an `app_subscriptions/update` payload.
 *
 * Pure, because the mapping from Shopify's subscription name to our plan id is the part
 * that goes wrong and it should not need a webhook to test. The name is what Shopify
 * echoes back from the plan the merchant chose, and if it stops matching, the shop
 * silently lands on free — which is the failure mode that would look like a bug in
 * gating rather than a bug here.
 *
 * Matching is by plan id contained in a lowercased name, so "Anchor Markets", "Markets",
 * and "Markets (annual)" all resolve. Deliberately forgiving in one direction only: an
 * unrecognised name resolves to free rather than to a guess, because a wrong *upgrade*
 * gives away a paid surface and a wrong *downgrade* is caught by the merchant instantly.
 */

import { isPlanId, PLAN_ORDER, type PlanId } from "./plans";

export interface SubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    trial_days?: number;
    created_at?: string;
  };
}

export interface ParsedSubscription {
  gid: string | null;
  status: string | null;
  planId: PlanId;
  trialEndsAt: Date | null;
}

export function parseSubscription(payload: unknown): ParsedSubscription {
  const subscription = (payload as SubscriptionPayload)?.app_subscription ?? {};
  const status = subscription.status?.toUpperCase() ?? null;

  return {
    gid: subscription.admin_graphql_api_id ?? null,
    status,
    // A cancelled or expired subscription is free regardless of what it was named.
    planId: status && !["ACTIVE", "ACCEPTED"].includes(status) ? "free" : planFromName(subscription.name),
    trialEndsAt: trialEnd(subscription.created_at, subscription.trial_days),
  };
}

/**
 * The plan a subscription name refers to.
 *
 * Checked from the most specific tier down, because "Anchor Markets and Wholesale" would
 * otherwise match whichever appeared first in the list rather than the higher tier.
 */
export function planFromName(name: string | undefined): PlanId {
  if (!name) return "free";

  const lowered = name.toLowerCase();
  for (const id of [...PLAN_ORDER].reverse()) {
    if (lowered.includes(id)) return id;
  }

  return isPlanId(lowered) ? lowered : "free";
}

function trialEnd(createdAt: string | undefined, trialDays: number | undefined): Date | null {
  if (!createdAt || !trialDays) return null;

  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return null;

  return new Date(started + trialDays * 24 * 60 * 60 * 1000);
}
