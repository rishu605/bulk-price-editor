/**
 * Subscription webhooks arriving out of order (#709).
 *
 * An upgrade activates the new subscription and cancels the old one, and Shopify sends a
 * webhook for each in no guaranteed order. The handler wrote whatever arrived, so when
 * the old plan's CANCELLED came last the merchant who had just paid for Markets was put
 * on Free: refused markets and B2B, and capped at the free variant limit.
 *
 * Driven through the webhook route itself; only `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

const deliveries: Array<{ shop: string; payload: unknown; admin?: unknown }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: async () => {
      const next = deliveries.shift()!;
      return { topic: "APP_SUBSCRIPTIONS_UPDATE", shop: next.shop, payload: next.payload, admin: next.admin };
    },
  },
}));

/** The webhook's Admin API client, answering what Shopify lists as active -- or failing. */
const shopifySays = (active: string[] | "unreachable") => ({
  graphql: async () => {
    if (active === "unreachable") throw new Error("fetch failed");
    return {
      json: async () => ({
        data: { currentAppInstallation: { activeSubscriptions: active.map((id) => ({ id })) } },
      }),
    };
  },
});

const OLD = "gid://shopify/AppSubscription/7091";
const NEW = "gid://shopify/AppSubscription/7092";

const subscription = (gid: string, name: string, status: string) => ({
  app_subscription: { admin_graphql_api_id: gid, name, status },
});

async function deliver(shop: string, payload: unknown, admin?: unknown) {
  deliveries.push({ shop, payload, admin });
  const { action } = await import("../../app/routes/webhooks.app.subscriptions_update");
  const response = await action({
    request: new Request("https://example.invalid/webhooks/app/subscriptions_update", { method: "POST" }),
    params: {},
    context: {},
  } as never);
  expect(response.status).toBe(200);
}

const planOf = (shopId: string) =>
  prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { planTier: true, subscriptionGid: true, subscriptionStatus: true },
  });

async function onGrowth(shopId: string) {
  await prisma.shop.update({
    where: { id: shopId },
    data: { planTier: "GROWTH", subscriptionGid: OLD, subscriptionStatus: "ACTIVE" },
  });
}

describe("chaos: subscription webhooks out of order", () => {
  it("keeps an upgraded shop on its new plan when the old plan's cancellation arrives last", async () => {
    await withChaos("subscription-order", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      await onGrowth(shopId);

      await deliver(domain, subscription(NEW, "Anchor Markets", "ACTIVE"));
      await deliver(domain, subscription(OLD, "Anchor Growth", "CANCELLED"));

      expect(await planOf(shopId), "the old plan's cancellation put a paying merchant on Free").toEqual({
        planTier: "MARKETS",
        subscriptionGid: NEW,
        subscriptionStatus: "ACTIVE",
      });
      const ignored = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, action: "billing.subscription-ignored" },
      });
      expect(ignored.entityId).toBe(OLD);

      // The other order was always right, and still is.
      await onGrowth(shopId);
      await deliver(domain, subscription(OLD, "Anchor Growth", "CANCELLED"));
      await deliver(domain, subscription(NEW, "Anchor Markets", "ACTIVE"));
      expect((await planOf(shopId)).planTier).toBe("MARKETS");

      // And cancelling the plan the shop is on still downgrades it.
      await deliver(domain, subscription(NEW, "Anchor Markets", "CANCELLED"));
      expect(await planOf(shopId)).toEqual({ planTier: "FREE", subscriptionGid: NEW, subscriptionStatus: "CANCELLED" });

      // A late ACTIVE for that cancelled subscription does not bring it back.
      await deliver(domain, subscription(NEW, "Anchor Markets", "ACTIVE"));
      expect((await planOf(shopId)).planTier).toBe("FREE");
    });
  });

  it("does not drop a paying shop to Free while an upgrade charge is pending or declined", async () => {
    await withChaos("subscription-pending", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      await onGrowth(shopId);

      await deliver(domain, subscription(NEW, "Anchor Wholesale", "PENDING"));
      await deliver(domain, subscription(NEW, "Anchor Wholesale", "DECLINED"));

      expect(await planOf(shopId)).toEqual({ planTier: "GROWTH", subscriptionGid: OLD, subscriptionStatus: "ACTIVE" });
    });
  });

  it("lands on the new plan when both webhooks are handled at once, on two processes", async () => {
    await withChaos("subscription-race", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const { applySubscriptionUpdate } = await import("../../app/services/billing.server");

      // Both read Growth-on-OLD before either writes. A check followed by a plain write
      // lets whichever finishes last win, and half the time that is the cancellation.
      for (let round = 0; round < 20; round++) {
        await onGrowth(shopId);
        await Promise.all([
          applySubscriptionUpdate(shopId, { gid: NEW, status: "ACTIVE", planId: "markets" }),
          applySubscriptionUpdate(shopId, { gid: OLD, status: "CANCELLED", planId: "free" }),
        ]);
        expect((await planOf(shopId)).planTier, `round ${round}`).toBe("MARKETS");
      }
    });
  });

  it("keeps a shop on its new plan when the old plan's ACTIVE is replayed after the switch (#787)", async () => {
    // Shopify retries webhooks. A delayed ACTIVE for the plan the merchant left reads
    // exactly like an upgrade -- the payload cannot tell them apart -- and applying it
    // moved them back onto the old plan. Shopify's list of active subscriptions can.
    await withChaos("subscription-replay", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      await prisma.shop.update({
        where: { id: shopId },
        data: { planTier: "MARKETS", subscriptionGid: NEW, subscriptionStatus: "ACTIVE" },
      });

      await deliver(domain, subscription(OLD, "Anchor Growth", "ACTIVE"), shopifySays([NEW]));

      expect(await planOf(shopId), "a replayed ACTIVE for the old plan moved the merchant back onto it").toEqual({
        planTier: "MARKETS",
        subscriptionGid: NEW,
        subscriptionStatus: "ACTIVE",
      });
      const ignored = await prisma.auditLogEntry.findFirstOrThrow({ where: { shopId, action: "billing.subscription-ignored" } });
      expect(ignored.entityId).toBe(OLD);
      expect(ignored.after).toMatchObject({ reason: expect.stringContaining("no longer lists") });

      // Replayed again: the same answer, and still one plan.
      await deliver(domain, subscription(OLD, "Anchor Growth", "ACTIVE"), shopifySays([NEW]));
      expect((await planOf(shopId)).planTier).toBe("MARKETS");
    });
  });

  it("still applies a real upgrade, and applies as before when Shopify cannot be asked", async () => {
    await withChaos("subscription-upgrade", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;

      await onGrowth(shopId);
      await deliver(domain, subscription(NEW, "Anchor Markets", "ACTIVE"), shopifySays([NEW]));
      expect((await planOf(shopId)).planTier, "a genuine upgrade was refused").toBe("MARKETS");

      // A failed lookup is not evidence: refusing would charge for a plan the app withholds.
      await onGrowth(shopId);
      await deliver(domain, subscription(NEW, "Anchor Markets", "ACTIVE"), shopifySays("unreachable"));
      expect((await planOf(shopId)).planTier).toBe("MARKETS");
    });
  });
});
