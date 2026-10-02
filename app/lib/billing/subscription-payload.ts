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

/** Statuses a shop pays for and gets its tier on. */
const PAID = new Set(["ACTIVE", "ACCEPTED"]);

/** Whether a subscription status is one the shop is paying on. */
export function paysOn(status: string | null | undefined): boolean {
  return PAID.has(status?.toUpperCase() ?? "");
}

/** Statuses a subscription never leaves. FROZEN is not one: a store that unfreezes resumes. */
const ENDED = new Set(["CANCELLED", "DECLINED", "EXPIRED"]);

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
    planId: status && !PAID.has(status) ? "free" : planFromName(subscription.name),
    trialEndsAt: trialEnd(subscription.created_at, subscription.trial_days),
  };
}

export interface StoredSubscription {
  subscriptionGid: string | null;
  subscriptionStatus: string | null;
}

/**
 * Why an update must not be applied over what is stored, or null to apply it (#709).
 *
 * Shopify does not deliver subscription webhooks in order. An upgrade activates the new
 * subscription and cancels the old one, and when the old one's CANCELLED arrives last,
 * writing it unconditionally put a merchant who had just paid for more on Free. Without a
 * timestamp to order by, the subscriptions themselves decide:
 *
 *   A shop paying on one subscription is not downgraded by news about another. That
 *   other one was replaced (the old plan's cancellation), or never went through (an
 *   upgrade charge still PENDING, or DECLINED).
 *
 *   A subscription that has ended does not come back. An ACTIVE for it arriving after its
 *   CANCELLED is the same reordering the other way round.
 */
export function staleSubscriptionUpdate(
  stored: StoredSubscription,
  update: Pick<ParsedSubscription, "gid" | "status">,
): string | null {
  const storedGid = stored.subscriptionGid;
  const storedStatus = stored.subscriptionStatus?.toUpperCase() ?? null;
  const status = update.status?.toUpperCase() ?? null;
  if (!storedGid || !update.gid || !storedStatus || !status) return null;

  if (update.gid !== storedGid && PAID.has(storedStatus) && !PAID.has(status)) {
    return `${status} for ${update.gid}, while the shop pays on ${storedGid}`;
  }
  if (update.gid === storedGid && ENDED.has(storedStatus) && PAID.has(status)) {
    return `${status} for ${update.gid}, which had already ${storedStatus === "DECLINED" ? "been declined" : storedStatus.toLowerCase()}`;
  }
  return null;
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
