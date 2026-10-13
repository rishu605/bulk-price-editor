/**
 * Which plan a shop is on, and what that does and does not allow.
 *
 * The load-bearing rule is edge case E8: **a downgrade must never orphan a store at sale
 * prices.** A merchant who drops to a cheaper plan mid-campaign still gets their
 * scheduled revert, still sees their history, still has rollback. Gates constrain what
 * can be *started*; nothing here can stop something finishing.
 *
 * That is not generosity. A store left at 40% off indefinitely because we stopped
 * reverting is a revenue incident we caused, and no amount of "they downgraded" makes
 * that a defensible position — least of all in a public review.
 *
 * So: no function in this module is called from the revert path, and the one that gates
 * a run is called only for applies. There is a test asserting exactly that.
 */

import type { Shop } from "@prisma/client";

import prisma from "../db.server";
import {
  canStart,
  canUseSurface,
  planFor,
  PLANS,
  type CampaignShape,
  type Entitlement,
  type Plan,
  type PlanId,
} from "../lib/billing/plans";
import { paysOn, staleSubscriptionUpdate } from "../lib/billing/subscription-payload";
import { currentSubscription } from "../lib/billing/billing-api";
import type { AdminClient } from "../lib/execution/sync-executor";
import type { AnchorActiveSubscriptionsQuery, AnchorSubscriptionStatusQuery } from "../types/admin.generated";
import { logger } from "../lib/logging/logger";

/** Shopify's subscription statuses that mean "this plan is real right now". */
const LIVE_STATUSES = new Set(["ACTIVE", "ACCEPTED"]);

export interface Billing {
  plan: Plan;
  /** True while a trial is running, so the UI can say how long is left. */
  trialing: boolean;
  trialEndsAt: Date | null;
  /** Dev and partner stores get every tier without a subscription. */
  exempt: boolean;
}

export async function billingFor(shopId: string): Promise<Billing> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      planTier: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      developerStore: true,
    },
  });

  return billingFrom(shop);
}

/**
 * The same answer from an already-loaded row, so a loader that has the shop does not
 * fetch it twice.
 */
export function billingFrom(
  shop: Pick<Shop, "planTier" | "subscriptionStatus" | "trialEndsAt" | "developerStore"> | null,
): Billing {
  if (!shop) return { plan: PLANS.free, trialing: false, trialEndsAt: null, exempt: false };

  // A dev store gets everything. Testing markets pricing against a development store is
  // the normal way to evaluate this app, and asking a partner to pay $34.90 to try it is
  // how you get evaluated by nobody.
  if (shop.developerStore) {
    return { plan: PLANS.wholesale, trialing: false, trialEndsAt: null, exempt: true };
  }

  // A subscription that is cancelled, frozen or expired means free — but only for what
  // can be *started*. Everything already running still finishes.
  const live = shop.subscriptionStatus === null || LIVE_STATUSES.has(shop.subscriptionStatus);
  const plan = live ? planFor(shop.planTier.toLowerCase()) : PLANS.free;

  const trialEndsAt = shop.trialEndsAt;
  const trialing = trialEndsAt !== null && trialEndsAt.getTime() > Date.now();

  return { plan, trialing, trialEndsAt, exempt: false };
}

/**
 * Whether this shop may start this campaign.
 *
 * Deliberately takes the shape rather than the campaign id, so the wizard can ask about
 * a campaign that does not exist yet and get the same answer the run will give.
 */
export async function canStartCampaign(
  shopId: string,
  shape: CampaignShape,
): Promise<Entitlement> {
  const { plan } = await billingFor(shopId);
  return canStart(plan, shape);
}

/** Whether a surface may be chosen, for the wizard's per-surface prompts. */
export async function surfaceEntitlement(
  shopId: string,
  kind: "base" | "market" | "b2b",
): Promise<Entitlement> {
  const { plan } = await billingFor(shopId);
  return canUseSurface(plan, kind);
}

export interface SubscriptionUpdate {
  gid: string | null;
  status: string | null;
  planId: PlanId;
  trialEndsAt?: Date | null;
}

/** Attempts at the compare-and-set before giving up on a shop whose row keeps moving. */
const WRITE_ATTEMPTS = 3;

/**
 * Records what Shopify told us about a subscription.
 *
 * Nothing about a campaign is touched here — not cancelled, not rescheduled, not
 * deleted. A downgrade changes what the merchant can start next; it does not reach into
 * work already in flight. That is the entire content of E8, and the safest way to
 * guarantee it is for this function to have no ability to break it.
 *
 * Webhooks arrive out of order, so an update that `staleSubscriptionUpdate` says is older
 * than what is stored is recorded and not applied (#709). The write is a compare-and-set
 * on the subscription it was judged against: an upgrade's two webhooks can land on two
 * processes at once, and a check followed by a plain write would let the stale one win
 * anyway.
 */
/**
 * The subscriptions Shopify says this installation is paying on right now.
 *
 * Asked on receipt of a paid event about a subscription that is not the stored one
 * (#787). Shopify redelivers webhooks, and their order is not guaranteed: a delayed
 * "ACTIVE" for the plan a merchant left yesterday looks exactly like an upgrade, and
 * applying it would put them back on the old plan. The payload cannot tell the two apart;
 * the installation's own list can.
 */
export const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query AnchorActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        trialDays
        createdAt
      }
    }
  }
`;

/** One subscription's status, for the one the shop was paying on when it is no longer active. */
export const SUBSCRIPTION_STATUS_QUERY = `#graphql
  query AnchorSubscriptionStatus($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
      }
    }
  }
`;

/**
 * Whether Shopify still lists a subscription as active, or null when it cannot say.
 *
 * Null -- a failed query, no client -- leaves the update to be applied as it always was:
 * refusing a real upgrade because a lookup failed would charge a merchant for a plan the
 * app then withholds.
 */
export function subscriptionStillActive(client: AdminClient): (gid: string) => Promise<boolean | null> {
  return async (gid) => {
    try {
      const { data } = await client.request<AnchorActiveSubscriptionsQuery>(ACTIVE_SUBSCRIPTIONS_QUERY, {});
      const active = data?.currentAppInstallation?.activeSubscriptions;
      return active ? active.some((subscription) => subscription.id === gid) : null;
    } catch (error) {
      logger.warn("active subscriptions unavailable", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  };
}

export async function applySubscriptionUpdate(
  shopId: string,
  update: SubscriptionUpdate,
  options: {
    /** Asks Shopify whether a subscription is still active. See `subscriptionStillActive`. */
    stillActive?: (gid: string) => Promise<boolean | null>;
  } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const before = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { planTier: true, subscriptionGid: true, subscriptionStatus: true },
    });
    if (!before) return;

    let stale = staleSubscriptionUpdate(before, update);

    // A paid event that would replace the shop's subscription with another one. Shopify
    // is asked whether that one is still active: a replay of the plan the merchant left
    // is not, and applying it would move them back onto it (#787).
    if (
      !stale &&
      options.stillActive &&
      update.gid &&
      before.subscriptionGid &&
      update.gid !== before.subscriptionGid &&
      paysOn(update.status) &&
      (await options.stillActive(update.gid)) === false
    ) {
      stale = `${update.status} for ${update.gid}, which Shopify no longer lists among this shop's active subscriptions -- a delayed or replayed event`;
    }

    if (stale) {
      await prisma.auditLogEntry.create({
        data: {
          shopId,
          action: "billing.subscription-ignored",
          entity: "subscription",
          entityId: update.gid ?? "none",
          before: { planTier: before.planTier, subscriptionGid: before.subscriptionGid } as never,
          after: { status: update.status, reason: stale } as never,
        },
      });
      logger.info("subscription update arrived out of order; kept the current plan", {
        shopId,
        plan: before.planTier,
        status: update.status,
      });
      return;
    }

    const written = await prisma.shop.updateMany({
      where: {
        id: shopId,
        subscriptionGid: before.subscriptionGid,
        subscriptionStatus: before.subscriptionStatus,
      },
      data: {
        subscriptionGid: update.gid,
        subscriptionStatus: update.status,
        planTier: update.planId.toUpperCase() as Shop["planTier"],
        planChangedAt: new Date(),
        // Set or moved, never cleared. Shopify's webhook carries no trial at all, and taking
        // its silence for "no trial" wiped the end of a 14-day trial the moment it began; a
        // cleared one would also hand a shop a second trial on its next plan (#860).
        ...(update.trialEndsAt ? { trialEndsAt: update.trialEndsAt } : {}),
      },
    });
    if (written.count === 0) continue; // another webhook moved the row; judge again

    await prisma.auditLogEntry.create({
      data: {
        shopId,
        action: "billing.subscription-updated",
        entity: "subscription",
        entityId: update.gid ?? "none",
        before: { planTier: before.planTier } as never,
        after: { planTier: update.planId.toUpperCase(), status: update.status } as never,
      },
    });

    logger.info("subscription updated", {
      shopId,
      from: before.planTier,
      to: update.planId,
      status: update.status,
    });
    return;
  }

  // Shopify redelivers a webhook that fails, so throwing here gets it judged again later
  // rather than dropped.
  throw new Error(`subscription update for ${shopId} kept racing another; retry`);
}

/**
 * Brings the shop's tier into line with what Shopify says it is paying on (#860).
 *
 * The Billing API's `activeSubscriptions` is the truth; the `app_subscriptions/update`
 * webhook is the news. Read on the plan page, so a merchant back from approving a charge
 * sees the plan they paid for at once rather than whenever the webhook lands, and a shop
 * whose subscription ended while no webhook arrived drops to Free instead of keeping a
 * paid tier for nothing. Applied through `applySubscriptionUpdate`, so its ordering guard
 * and its audit entry hold here too.
 *
 * Never throws: a lookup that fails leaves the stored tier as it was, and the page still
 * renders.
 */
export async function syncSubscription(shopId: string, client: AdminClient): Promise<void> {
  try {
    const { data } = await client.request<AnchorActiveSubscriptionsQuery>(ACTIVE_SUBSCRIPTIONS_QUERY, {});
    const listed = data?.currentAppInstallation?.activeSubscriptions;
    if (!listed) return;

    const stored = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { planTier: true, subscriptionGid: true, subscriptionStatus: true, trialEndsAt: true },
    });
    if (!stored) return;

    const current = currentSubscription(listed);
    if (current) {
      // The trial too: the webhook usually lands first, and it says nothing about one.
      const unchanged =
        current.gid === stored.subscriptionGid &&
        current.status === stored.subscriptionStatus?.toUpperCase() &&
        current.planId.toUpperCase() === stored.planTier &&
        (!current.trialEndsAt || current.trialEndsAt.getTime() === stored.trialEndsAt?.getTime());
      if (!unchanged) await applySubscriptionUpdate(shopId, current);
      return;
    }

    // Nothing active, while the shop is recorded as paying: that subscription ended --
    // cancelled, declined, frozen. Its own status is asked for rather than assumed, because a
    // frozen store's subscription comes back when the store unfreezes, and recording it as
    // cancelled would refuse that.
    if (stored.subscriptionGid && paysOn(stored.subscriptionStatus)) {
      const { data: node } = await client.request<AnchorSubscriptionStatusQuery>(SUBSCRIPTION_STATUS_QUERY, {
        id: stored.subscriptionGid,
      });
      const status = (node?.node && "status" in node.node ? node.node.status : null) ?? "CANCELLED";
      if (paysOn(status)) return;
      await applySubscriptionUpdate(shopId, { gid: stored.subscriptionGid, status, planId: "free" });
    }
  } catch (error) {
    logger.warn("subscription sync failed; kept the stored plan", {
      shopId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Whether a charge for this shop is a test charge.
 *
 * A development store cannot be charged at all: Shopify only lets it approve a test
 * charge, which is also how App Review tries a plan change. `BILLING_TEST_CHARGES=true`
 * makes every charge a test one, for a staging deploy. Anywhere else the charge is real --
 * the library's own default is a test charge, which would never have taken a payment.
 */
export function isTestCharge(developerStore: boolean): boolean {
  return developerStore || process.env.BILLING_TEST_CHARGES === "true";
}

/** The subscriptions to end when a merchant moves to Free. */
export async function activeSubscriptionIds(client: AdminClient): Promise<string[]> {
  const { data } = await client.request<AnchorActiveSubscriptionsQuery>(ACTIVE_SUBSCRIPTIONS_QUERY, {});
  return (data?.currentAppInstallation?.activeSubscriptions ?? []).map((subscription) => subscription.id);
}

/**
 * Campaigns a downgrade will stop the merchant re-running, so the app can say so.
 *
 * Reported, never acted on. Telling somebody "these three campaigns need Markets to run
 * again" is help; silently pausing them is the thing E8 exists to forbid.
 */
export async function campaignsAffectedBy(shopId: string, plan: Plan) {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["DRAFT", "SCHEDULED", "ACTIVE", "PARTIAL"] } },
    select: { id: true, name: true, status: true, surfaces: true },
  });

  const { parseSurfaces } = await import("./campaigns/market-surfaces.server");
  const lists = await prisma.priceListRecord.findMany({
    where: { shopId },
    select: { priceListGid: true, surfaceKind: true },
  });
  const kindOf = new Map(lists.map((list) => [list.priceListGid, list.surfaceKind]));

  return campaigns
    .map((campaign) => {
      const surfaces = parseSurfaces(campaign.surfaces);
      const usesMarkets = surfaces.priceLists.some((gid) => kindOf.get(gid) !== "B2B");
      const usesB2b = surfaces.priceLists.some((gid) => kindOf.get(gid) === "B2B");

      const verdict = canStart(plan, { variants: 0, markets: usesMarkets, b2b: usesB2b });
      return verdict.allowed ? null : { ...campaign, reason: verdict.message };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}
