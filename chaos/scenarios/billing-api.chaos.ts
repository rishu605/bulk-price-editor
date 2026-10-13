/**
 * A merchant changes plan, and the app follows the subscription Shopify bills (#860).
 *
 * App Review paused the submission: the plan button led to Shopify's hosted App Pricing
 * picker, which was a 404 because the listing is on manual pricing and no App Pricing
 * plans exist (1.2.1). The plan page now charges through the Billing API itself, reads the
 * plan back from `activeSubscriptions`, and an uninstall ends the plan so a reinstall asks
 * for approval again (1.2.2).
 *
 * Driven through the plan route's own loader and action and the uninstall webhook's action.
 * Only Shopify is replaced: `authenticate` hands back an admin that answers the app's
 * queries from a small model of one store's subscriptions, and a `billing` that records
 * what it was asked to charge or cancel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { resetAppHandleCache } from "../../app/services/app-handle.server";
import { withChaos } from "../harness/scenario";

interface Sub {
  id: string;
  name: string;
  status: string;
  trialDays: number;
  createdAt: string;
}

const store = {
  domain: "",
  developer: false,
  active: [] as Sub[],
  statuses: new Map<string, string>(),
  failActive: false,
};
const requested: Array<Record<string, unknown>> = [];
const cancelled: Array<Record<string, unknown>> = [];

const admin = {
  async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
    let data: unknown;
    if (query.includes("AnchorActiveSubscriptions")) {
      if (store.failActive) throw new Error("Shopify is unavailable");
      data = { currentAppInstallation: { activeSubscriptions: store.active } };
    } else if (query.includes("AnchorSubscriptionStatus")) {
      const id = String(options?.variables?.id);
      data = { node: { id, status: store.statuses.get(id) ?? "CANCELLED" } };
    } else if (query.includes("AnchorShopCurrency")) {
      data = { shop: { currencyCode: "USD", ianaTimezone: "UTC", plan: { partnerDevelopment: store.developer } } };
    } else if (query.includes("AnchorAppHandle")) {
      data = { currentAppInstallation: { app: { handle: "bulk-price-editor-98" } } };
    } else {
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    }
    return new Response(JSON.stringify({ data }));
  },
};

const billing = {
  // What the library does: create the charge, then leave the app for Shopify's approval
  // screen by throwing App Bridge's redirect.
  async request(args: Record<string, unknown>) {
    requested.push(args);
    throw new Response(null, {
      status: 401,
      headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": "https://admin.shopify.com/charges/confirm" },
    });
  },
  async cancel(args: { subscriptionId: string }) {
    cancelled.push(args);
    store.statuses.set(args.subscriptionId, "CANCELLED");
    store.active = store.active.filter((sub) => sub.id !== args.subscriptionId);
  },
};

let webhookShop = "";
let webhook: { topic: string; payload?: unknown } = { topic: "APP_UNINSTALLED" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ admin, session: { shop: store.domain }, billing }),
    webhook: async () => ({ shop: webhookShop, session: null, admin, ...webhook }),
  },
}));

afterEach(() => {
  webhook = { topic: "APP_UNINSTALLED" };
  Object.assign(store, { developer: false, active: [], statuses: new Map(), failActive: false });
  requested.length = 0;
  cancelled.length = 0;
  resetAppHandleCache();
});

const DAY = 86_400_000;
const gid = (id: string) => `gid://shopify/AppSubscription/${id}`;

async function choose(plan: string): Promise<unknown> {
  const { action } = await import("../../app/routes/app.settings.plan");
  const body = new FormData();
  body.set("plan", plan);
  return action({ request: new Request("https://example.invalid/app/settings/plan", { method: "POST", body }), params: {}, context: {} } as never).catch(
    (thrown: unknown) => thrown,
  );
}

async function openPlanPage(query = "") {
  const { loader } = await import("../../app/routes/app.settings.plan");
  return loader({ request: new Request(`https://example.invalid/app/settings/plan${query}`), params: {}, context: {} } as never);
}

const shopOf = (shopId: string) => prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

describe("chaos: a merchant changes plan", () => {
  it("is sent to Shopify to approve the charge at plans.ts's price, with what is left of the trial, and back to this page", async () => {
    await withChaos("billing-request", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;

      const thrown = await choose("markets");
      expect(thrown, "the action should leave the app for Shopify's approval screen").toBeInstanceOf(Response);
      expect((thrown as Response).headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url")).toBe("https://admin.shopify.com/charges/confirm");
      expect(requested[0]).toEqual({
        plan: "Markets",
        isTest: false,
        trialDays: 14,
        returnUrl: `https://admin.shopify.com/store/${domain.replace(".myshopify.com", "")}/apps/bulk-price-editor-98/app/settings/plan`,
      });

      // A development store -- App Review's, for one -- can only approve a test charge.
      store.developer = true;
      await choose("growth");
      expect(requested[1]).toMatchObject({ plan: "Growth", isTest: true });

      // A trial already under way carries over; one that ended is not given again.
      await prisma.shop.update({ where: { id: shopId }, data: { trialEndsAt: new Date(Date.now() + 4.5 * DAY) } });
      await choose("wholesale");
      expect(requested[2]).toMatchObject({ plan: "Wholesale", trialDays: 5 });
      await prisma.shop.update({ where: { id: shopId }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
      await choose("wholesale");
      expect(requested[3]).toMatchObject({ trialDays: 0 });

      expect(await choose("platinum")).toMatchObject({ ok: false, message: expect.stringMatching(/^That plan doesn't exist/) });
    });
  });

  it("shows the plan paid for as soon as the merchant is back, before any webhook -- and says so when they declined", async () => {
    await withChaos("billing-return", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;

      // A shop on Free -- the fixture's is on the top tier, so no scenario is gated.
      await prisma.shop.update({ where: { id: shopId }, data: { planTier: "FREE", subscriptionGid: null, subscriptionStatus: null } });

      // Declined: Shopify returns them with the charge's id, and nothing is active.
      const declined = await openPlanPage("?charge_id=202");
      expect(declined).toMatchObject({ current: "free", returned: "declined" });

      // Approved.
      const createdAt = new Date().toISOString();
      store.active = [{ id: gid("101"), name: "Markets", status: "ACTIVE", trialDays: 14, createdAt }];
      store.statuses.set(gid("101"), "ACTIVE");
      const approved = await openPlanPage("?charge_id=101");
      expect(approved).toMatchObject({ current: "markets", returned: "approved", trialing: true });

      const shop = await shopOf(shopId);
      expect(shop).toMatchObject({ planTier: "MARKETS", subscriptionGid: gid("101"), subscriptionStatus: "ACTIVE" });
      expect(shop.trialEndsAt?.getTime()).toBe(Date.parse(createdAt) + 14 * DAY);
      expect(
        await prisma.auditLogEntry.count({ where: { shopId, action: "billing.subscription-updated" } }),
        "the change is in the record like a webhook's",
      ).toBe(1);

      // Opened again: nothing new to record.
      await openPlanPage();
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "billing.subscription-updated" } })).toBe(1);
    });
  });

  it("keeps the trial when Shopify's webhook, which never mentions one, lands before the merchant is back", async () => {
    await withChaos("billing-webhook-first", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;
      webhookShop = domain;
      await prisma.shop.update({ where: { id: shopId }, data: { planTier: "FREE", subscriptionGid: null, subscriptionStatus: null, trialEndsAt: null } });

      const createdAt = new Date().toISOString();
      store.active = [{ id: gid("601"), name: "Markets", status: "ACTIVE", trialDays: 14, createdAt }];
      // The payload as Shopify sends it on boltify-apps: no trial in it anywhere.
      webhook = {
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        payload: { app_subscription: { admin_graphql_api_id: gid("601"), name: "Markets", status: "ACTIVE", created_at: createdAt } },
      };
      const { action: subscriptionsUpdate } = await import("../../app/routes/webhooks.app.subscriptions_update");
      const deliver = () => subscriptionsUpdate({ request: new Request("https://example.invalid/webhooks/app/subscriptions_update", { method: "POST" }) } as never);
      await deliver();
      expect((await shopOf(shopId)).planTier).toBe("MARKETS");

      // Back on the page: the trial is read from Shopify's own list.
      expect(await openPlanPage("?charge_id=601")).toMatchObject({ current: "markets", returned: "approved", trialing: true });
      const trialEndsAt = Date.parse(createdAt) + 14 * DAY;
      expect((await shopOf(shopId)).trialEndsAt?.getTime()).toBe(trialEndsAt);

      // A redelivery of the same webhook does not take it away again.
      await deliver();
      expect((await shopOf(shopId)).trialEndsAt?.getTime(), "a webhook's silence cleared the trial").toBe(trialEndsAt);
      webhook = { topic: "APP_UNINSTALLED" };
    });
  });

  it("goes straight to the new plan on an upgrade, when the old plan's cancellation lands first", async () => {
    await withChaos("billing-upgrade-order", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      webhookShop = domain;
      // On Markets; the merchant approves Wholesale. Shopify already lists only Wholesale as
      // active when it tells us Markets was cancelled -- the order seen live on boltify-apps.
      await prisma.shop.update({ where: { id: shopId }, data: { planTier: "MARKETS", subscriptionGid: gid("701"), subscriptionStatus: "ACTIVE" } });
      store.active = [{ id: gid("702"), name: "Wholesale", status: "ACTIVE", trialDays: 0, createdAt: new Date().toISOString() }];
      store.statuses.set(gid("701"), "CANCELLED");
      webhook = {
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        payload: { app_subscription: { admin_graphql_api_id: gid("701"), name: "Markets", status: "CANCELLED", created_at: new Date().toISOString() } },
      };
      const { action } = await import("../../app/routes/webhooks.app.subscriptions_update");
      await action({ request: new Request("https://example.invalid/webhooks/app/subscriptions_update", { method: "POST" }) } as never);

      expect(await shopOf(shopId), "the merchant who just paid for Wholesale was put on Free").toMatchObject({
        planTier: "WHOLESALE",
        subscriptionGid: gid("702"),
        subscriptionStatus: "ACTIVE",
      });
    });
  });

  it("switches to Free by cancelling the subscription, prorated", async () => {
    await withChaos("billing-free", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;
      store.active = [{ id: gid("301"), name: "Growth", status: "ACTIVE", trialDays: 0, createdAt: new Date().toISOString() }];
      await openPlanPage();
      expect((await shopOf(shopId)).planTier).toBe("GROWTH");

      expect(await choose("free")).toMatchObject({ ok: true, message: expect.stringMatching(/^Your subscription is cancelled and you're on Free/) });
      expect(cancelled).toEqual([{ subscriptionId: gid("301"), isTest: false, prorate: true }]);
      expect(await shopOf(shopId)).toMatchObject({ planTier: "FREE", subscriptionStatus: "CANCELLED" });
      expect(await openPlanPage()).toMatchObject({ current: "free" });
    });
  });

  it("drops to Free when a subscription ends with no webhook, and back when a frozen store unfreezes", async () => {
    await withChaos("billing-ended", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;
      store.active = [{ id: gid("401"), name: "Markets", status: "ACTIVE", trialDays: 0, createdAt: new Date().toISOString() }];
      await openPlanPage();

      // The store is frozen: Shopify lists nothing active, and says why.
      store.active = [];
      store.statuses.set(gid("401"), "FROZEN");
      expect(await openPlanPage()).toMatchObject({ current: "free" });
      expect(await shopOf(shopId)).toMatchObject({ planTier: "FREE", subscriptionStatus: "FROZEN" });

      // It unfreezes. Recorded as cancelled, this would have been refused as an ended
      // subscription coming back.
      store.active = [{ id: gid("401"), name: "Markets", status: "ACTIVE", trialDays: 0, createdAt: new Date().toISOString() }];
      expect(await openPlanPage()).toMatchObject({ current: "markets" });

      // A lookup that fails changes nothing, and the page still opens.
      store.failActive = true;
      expect(await openPlanPage()).toMatchObject({ current: "markets" });
    });
  });

  it("ends the plan on uninstall, so a reinstall asks for approval again and gets no second trial", async () => {
    await withChaos("billing-uninstall", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      store.domain = domain;
      const trialEndsAt = new Date(Date.now() + 6.5 * DAY);
      await prisma.shop.update({
        where: { id: shopId },
        data: { planTier: "MARKETS", subscriptionGid: gid("501"), subscriptionStatus: "ACTIVE", trialEndsAt },
      });

      webhookShop = domain;
      const { action } = await import("../../app/routes/webhooks.app.uninstalled");
      await action({
        request: new Request("https://example.invalid/webhooks/app/uninstalled", {
          method: "POST",
          headers: { "x-shopify-triggered-at": new Date().toISOString() },
        }),
      } as never);

      expect(await shopOf(shopId)).toMatchObject({ planTier: "FREE", subscriptionGid: null, subscriptionStatus: null, trialEndsAt });

      // Back again: nothing is active, so the shop is on Free until it approves a charge, and
      // the trial is what was left of the first one.
      await prisma.shop.update({ where: { id: shopId }, data: { uninstalledAt: null, installedAt: new Date() } });
      expect(await openPlanPage()).toMatchObject({ current: "free" });
      await choose("markets");
      expect(requested[0]).toMatchObject({ plan: "Markets", trialDays: 7 });
    });
  });
});
