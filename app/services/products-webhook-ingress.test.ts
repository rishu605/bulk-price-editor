/**
 * The products webhook route, with a worker queue: verify, one insert, one enqueue, 200 --
 * and nothing else in the request (#811).
 *
 * The route used to upsert the mirror, look for drift and enrol in the request, in the web
 * process's ten pooled connections, and a 100k run's echoes held every page at the pool
 * timeout (#803). Every database call the route makes is recorded here, whatever model or
 * raw method it reaches for, so a lookup that creeps back into the request fails this test
 * rather than a store's pages.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  db: [] as string[],
  enqueued: [] as Array<{ name: string; ref: unknown }>,
  /** What the delivery's insert answers: the row as the database left it. */
  persisted: { id: "event-1", shopId: "shop-1", status: "RECEIVED" } as { id: string; shopId: string | null; status: string },
  queue: true,
  enqueueFails: false,
  library: 0,
}));

/** Every property is a model, and every model method a recorded call that finds nothing. */
vi.mock("../db.server", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, method) => async () => {
          seen.db.push(`${name}.${String(method)}`);
          return null;
        },
      },
    );
  return {
    default: new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== "string") return undefined;
          if (name.startsWith("$")) {
            return async () => {
              seen.db.push(name);
              return [seen.persisted];
            };
          }
          return model(name);
        },
      },
    ),
  };
});

vi.mock("../shopify.server", () => ({
  authenticate: {
    webhook: async () => {
      seen.library += 1;
      seen.db.push("authenticate.webhook (offline session load)");
      return { shop: "shop.myshopify.com", topic: "PRODUCTS_UPDATE", payload: {}, admin: undefined };
    },
  },
}));

vi.mock("../worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/web-queue.server")>()),
  webQueue: () =>
    seen.queue
      ? {
          async enqueue(name: string, ref: unknown) {
            if (seen.enqueueFails) throw new Error("Redis is not answering");
            seen.enqueued.push({ name, ref });
          },
          async depths() {
            return {};
          },
          async close() {},
        }
      : null,
}));

import { webhookSignature } from "../lib/shopify/webhook-hmac.server";
import { action } from "../routes/webhooks.products";

const SECRET = "unit-secret";

function delivery(body: unknown, { signature }: { signature?: string } = {}) {
  const raw = JSON.stringify(body);
  return {
    request: new Request("https://example.invalid/webhooks/products", {
      method: "POST",
      body: raw,
      headers: {
        "X-Shopify-Hmac-Sha256": signature ?? webhookSignature(raw, SECRET),
        "X-Shopify-Topic": "products/update",
        "X-Shopify-Shop-Domain": "shop.myshopify.com",
        "X-Shopify-API-Version": "2026-07",
        "X-Shopify-Webhook-Id": "webhook-1",
      },
    }),
    params: {},
    context: {},
  } as never;
}

/** A large product's update, as an echo storm is made of. */
const product = {
  id: 1,
  admin_graphql_api_id: "gid://shopify/Product/1",
  updated_at: "2026-10-29T12:00:00Z",
  variants: Array.from({ length: 100 }, (_, i) => ({ admin_graphql_api_id: `gid://shopify/ProductVariant/${i}`, price: "9.99" })),
};

beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = SECRET;
  seen.db.length = 0;
  seen.enqueued.length = 0;
  seen.persisted = { id: "event-1", shopId: "shop-1", status: "RECEIVED" };
  seen.queue = true;
  seen.enqueueFails = false;
  seen.library = 0;
});

describe("the products webhook route with a worker queue (#811)", () => {
  it("makes one database call, the delivery's insert, and hands the shop's drain to the worker", async () => {
    const response = await action(delivery(product));

    expect(response.status).toBe(200);
    expect(seen.db, "the request did database work beyond persisting the delivery").toEqual(["$queryRaw"]);
    expect(seen.enqueued).toEqual([{ name: "webhooks", ref: { shopId: "shop-1" } }]);
    expect(seen.library, "the request went through authenticate.webhook, which loads a session").toBe(0);
  });

  it("does not ring the worker for a redelivery already handled, or for a shop it has never recorded", async () => {
    seen.persisted = { id: "event-1", shopId: "shop-1", status: "PROCESSED" };
    expect((await action(delivery(product))).status).toBe(200);
    seen.persisted = { id: "event-2", shopId: null, status: "PROCESSED" };
    expect((await action(delivery(product))).status).toBe(200);

    expect(seen.enqueued).toEqual([]);
    expect(seen.db).toEqual(["$queryRaw", "$queryRaw"]);
  });

  it("answers 200 once the delivery is persisted, even when the queue does not take the job", async () => {
    // A 5xx would have Shopify send it again -- the retries that sustained #803. The row is
    // persisted, and the worker's tick rings the shop.
    seen.enqueueFails = true;
    expect((await action(delivery(product))).status).toBe(200);
    expect(seen.db).toEqual(["$queryRaw"]);
  });

  it("refuses a delivery it cannot verify before touching the database", async () => {
    const refused = await action(delivery(product, { signature: webhookSignature("{}", SECRET) })).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);
    expect(seen.db).toEqual([]);
  });

  it("without a worker queue, authenticates through the library and handles it in the request, as before", async () => {
    seen.queue = false;
    expect((await action(delivery(product))).status).toBe(200);
    expect(seen.library).toBe(1);
    expect(seen.enqueued).toEqual([]);
    // The shop is looked up first, as it always was; this one is unknown, so nothing more.
    expect(seen.db[0]).toBe("authenticate.webhook (offline session load)");
    expect(seen.db).toContain("shop.findUnique");
  });
});
