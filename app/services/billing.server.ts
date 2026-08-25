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

/**
 * Records what Shopify told us about a subscription.
 *
 * Nothing about a campaign is touched here — not cancelled, not rescheduled, not
 * deleted. A downgrade changes what the merchant can start next; it does not reach into
 * work already in flight. That is the entire content of E8, and the safest way to
 * guarantee it is for this function to have no ability to break it.
 */
export async function applySubscriptionUpdate(
  shopId: string,
  update: SubscriptionUpdate,
): Promise<void> {
  const before = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { planTier: true },
  });

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      subscriptionGid: update.gid,
      subscriptionStatus: update.status,
      planTier: update.planId.toUpperCase() as Shop["planTier"],
      planChangedAt: new Date(),
      ...(update.trialEndsAt === undefined ? {} : { trialEndsAt: update.trialEndsAt }),
    },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      action: "billing.subscription-updated",
      entity: "subscription",
      entityId: update.gid ?? "none",
      before: { planTier: before?.planTier ?? null } as never,
      after: { planTier: update.planId.toUpperCase(), status: update.status } as never,
    },
  });

  logger.info("subscription updated", {
    shopId,
    from: before?.planTier ?? null,
    to: update.planId,
    status: update.status,
  });
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
