/**
 * A store's prices are never recorded in a currency Anchor guessed (#1101).
 *
 * A products webhook for a store with nothing mirrored yet -- before its first sync, or on a
 * store the sync refused (#1089) -- took US dollars, so a yen store's ¥1,200 product was
 * recorded as $1,200.00 and enrolment could capture baselines from it. And a shop query that
 * did not state the currency synced the whole catalogue as dollars.
 *
 * Through the products webhook's own action, and `runFullSync`, against the fake store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { runFullSync } from "../../app/services/sync-job.server";
import { chaosAdminClient } from "../harness/http-client";
import { CHAOS_ACTOR, type ChaosContext, withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

// No worker queue, so the route handles each delivery in the request -- its fallback, and
// the same `processProductsWebhook` the worker drains with (#811). REDIS_URL is set in CI's
// chaos job, so without this the route would hand the delivery to a queue nothing here
// consumes. The queued path itself is `webhook-queue.chaos.ts`'s.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

/** The webhook's Admin API handle, answered by the fake store. */
const adminFor = (endpoint: string) => ({
  async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: options?.variables ?? {} }),
    });
    return { json: () => response.json() };
  },
});

/** Nothing mirrored: the store as it is before its first sync. */
async function unsynced(chaos: ChaosContext) {
  const { shopId } = chaos.fixture;
  await prisma.baseline.deleteMany({ where: { shopId } });
  await prisma.priceSurfaceEntry.deleteMany({ where: { shopId } });
  await prisma.variantIndex.deleteMany({ where: { shopId } });
}

async function productsUpdate(chaos: ChaosContext, admin: unknown) {
  const { domain, variantGids, productOf } = chaos.fixture;
  const [variantGid] = variantGids;
  pending = {
    shop: domain,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: productOf.get(variantGid)!,
      title: "Lantern",
      status: "active",
      tags: "chaos",
      updated_at: new Date().toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "Default", price: "1200", compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

describe("chaos: a store's currency before its first sync", () => {
  it("records a webhook's prices in the store's currency, asked of Shopify, or not at all", async () => {
    await withChaos("currency-before-sync", { catalog: { products: 1, variantsPerProduct: 1, currency: "JPY" } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      chaos.fake.shopCurrency = "JPY";
      await unsynced(chaos);

      // Shopify answers: the price is ¥1,200, in yen.
      await productsUpdate(chaos, adminFor(chaos.server.endpoint()));
      const row = await prisma.variantIndex.findFirstOrThrow({ where: { shopId } });
      expect(row.currency, "a yen store's price was recorded in dollars").toBe("JPY");
      expect(row.price).toBe(1_200n);

      // Nobody to ask: nothing is recorded, rather than dollars.
      await unsynced(chaos);
      await productsUpdate(chaos, undefined);
      expect(await prisma.variantIndex.count({ where: { shopId } }), "a price was recorded in a guessed currency").toBe(0);
      expect(await prisma.baseline.count({ where: { shopId } })).toBe(0);
    });
  });

  it("stops a sync whose shop query does not state the currency, and says so", async () => {
    await withChaos("currency-unstated-sync", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      await unsynced(chaos);
      const real = chaosAdminClient(chaos.server.endpoint());
      const silent: AdminClient = {
        async request(query, variables) {
          if (query.includes("AnchorShopCurrency")) {
            return { data: { shop: { ianaTimezone: "UTC", plan: { partnerDevelopment: false } } } as never };
          }
          return real.request(query, variables);
        },
      };

      const sync = await runFullSync(shopId, silent, CHAOS_ACTOR);
      expect(sync.errors.join(" ")).toMatch(/couldn't read your store's currency from Shopify, so it read none of your products/);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).syncFailure).toMatch(/couldn't read your store's currency/);
      expect(await prisma.variantIndex.count({ where: { shopId } }), "the catalogue was synced in a guessed currency").toBe(0);
    });
  });
});
