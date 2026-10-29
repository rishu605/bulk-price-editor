/**
 * Products webhooks persisted by the web process and handled by the worker (#811).
 *
 * The route used to do all of a delivery's work in the request: mirror upsert, tombstoning,
 * drift, enrolment, notifications, in the web process's ten pooled connections. A 100k run
 * sends thousands of `products/update` echoes, and after anchor-perf's revert died (#803)
 * they held every page at the pool timeout for 45 minutes. Now the route verifies, inserts
 * the delivery and rings the shop's drain; the worker drains it, a product at a time and
 * only its newest delivery, our own echoes dropped before any other work.
 *
 * Through the real route and the real worker handler (`handleJob`), against Postgres. The
 * route's queue records what it is handed instead of holding it in Redis, so each test drains
 * when a worker would, and can look at the database in between. Requests are signed with a
 * test secret: the queued path verifies the HMAC itself, and the library's
 * `authenticate.webhook` -- mocked here for the inline test only -- must never be reached.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { recordWriteIntents } from "../../app/services/drift.server";
import { webhookSignature } from "../../app/lib/shopify/webhook-hmac.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { withChaos, type ChaosContext } from "../harness/scenario";

const SECRET = "chaos-811-webhook-secret";

/** What the route handed the worker, in order. */
const rung: Array<{ name: QueueName; ref: JobRef }> = [];
/** "none" is a web process with no worker queue: the route's inline fallback. */
let queueMode: "queued" | "none" = "queued";
/** Whatever the inline path's `authenticate.webhook` answers with, and how often it was asked. */
let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };
let libraryCalls = 0;

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    webhook: async () => {
      libraryCalls += 1;
      return pending;
    },
  },
}));

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () =>
    queueMode === "none"
      ? null
      : {
          async enqueue(name: QueueName, ref: JobRef) {
            rung.push({ name, ref });
          },
          async depths() {
            return {} as never;
          },
          async close() {},
        },
}));

/** The worker's session for the fixture shop: Shopify says no product here is a gift card. */
vi.mock("../../app/services/admin-client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/admin-client.server")>()),
  adminClientForShop: async () => ({
    async request(_query: string, variables: Record<string, unknown>) {
      return { data: { product: { id: variables.id, isGiftCard: false } } } as never;
    },
  }),
}));

let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = previousSecret;
});
afterEach(() => {
  vi.restoreAllMocks();
  rung.length = 0;
  queueMode = "queued";
  libraryCalls = 0;
});

let sequence = 0;
const webhookId = (label: string) => `811-${label}-${Date.now()}-${++sequence}`;

/** A delivery as Shopify sends one: the body, signed, with the headers the library requires. */
function signed(shop: string, topic: string, payload: unknown, id: string, signature?: string): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.invalid/webhooks/products", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": signature ?? webhookSignature(body, SECRET),
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": id,
    },
  });
}

async function post(request: Request): Promise<Response> {
  const { action } = await import("../../app/routes/webhooks.products");
  return action({ request, params: {}, context: {} } as never);
}

/** Every turn of the shop's drain the worker would run, as it would run them. */
async function drain(shopId: string): Promise<number> {
  const { handleJob } = await import("../../app/worker/handlers.server");
  let turns = 1;
  while ((await handleJob("webhooks", { shopId })) === "again") turns += 1;
  return turns;
}

/**
 * The product as the fixture's mirror holds it -- titled by its variant's gid, tagged
 * `chaos`, nothing else set -- at `price`. A delivery like this whose price is a write of
 * ours changes nothing the mirror does not already know.
 */
function productAt(chaos: ChaosContext, variantGid: string, price: string, updatedAt: Date) {
  return {
    admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
    title: variantGid,
    status: "active",
    vendor: null,
    product_type: null,
    tags: "chaos",
    updated_at: updatedAt.toISOString(),
    variants: [
      {
        admin_graphql_api_id: variantGid,
        title: "Default Title",
        price,
        compare_at_price: null,
        sku: null,
        barcode: null,
        inventory_quantity: null,
      },
    ],
    variant_gids: [{ admin_graphql_api_id: variantGid }],
  };
}

/**
 * Mirror work by variant: every upsert of a variant's mirror rows, and every product the
 * full path read the version of -- its first step after the echo check. `fail` makes that
 * read throw for a product, as a database that has gone away or a handler bug would.
 */
function watchMirror(fail: (productGid: string) => Error | null = () => null) {
  const upserted: string[] = [];
  const versioned: string[] = [];
  const surfaced: string[] = [];
  const upsertIndex = prisma.variantIndex.upsert.bind(prisma.variantIndex);
  const upsertSurface = prisma.priceSurfaceEntry.upsert.bind(prisma.priceSurfaceEntry);
  const aggregate = prisma.variantIndex.aggregate.bind(prisma.variantIndex);
  vi.spyOn(prisma.variantIndex, "upsert").mockImplementation(((args: { where: { shopId_variantGid: { variantGid: string } } }) => {
    upserted.push(args.where.shopId_variantGid.variantGid);
    return upsertIndex(args as never);
  }) as never);
  vi.spyOn(prisma.priceSurfaceEntry, "upsert").mockImplementation(((args: { where: { shopId_variantGid_surfaceKind_priceListGid: { variantGid: string } } }) => {
    surfaced.push(args.where.shopId_variantGid_surfaceKind_priceListGid.variantGid);
    return upsertSurface(args as never);
  }) as never);
  vi.spyOn(prisma.variantIndex, "aggregate").mockImplementation(((args: { where: { productGid: string } }) => {
    const error = fail(args.where.productGid);
    if (error) throw error;
    versioned.push(args.where.productGid);
    return aggregate(args as never);
  }) as never);
  return { upserted, versioned, surfaced };
}

const deliveriesOf = (shopId: string) =>
  prisma.webhookEvent.findMany({ where: { shopId }, orderBy: { receivedAt: "asc" } });

describe("chaos: products webhooks through the worker", () => {
  it("the route persists and rings the shop, and does nothing else; the worker does the rest", async () => {
    await withChaos("webhook-queue-ingress", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      const edited = variantGids[0];
      const mirrored = await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: edited } });

      // The merchant edits a price under the running sale.
      const id = webhookId("ingress");
      const response = await post(signed(domain, "products/update", productAt(chaos, edited, "1.37", new Date(Date.now() + 60_000)), id));

      expect(response.status).toBe(200);
      expect(rung, "the route did not hand the shop's drain to the worker").toEqual([{ name: "webhooks", ref: { shopId } }]);
      expect(libraryCalls, "the queued path loaded a session through authenticate.webhook").toBe(0);
      const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } });
      expect(row).toMatchObject({ shopId, shopDomain: domain, topic: "products/update", status: "RECEIVED", attempts: 1, processedAt: null });
      expect(row.subjectGid).toBe(chaos.fixture.productOf.get(edited));
      expect((row.payload as { variants: Array<{ price: string }> }).variants[0].price).toBe("1.37");
      // Nothing was handled in the request.
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: edited } })).livePrice).toBe(mirrored.livePrice);
      expect(await prisma.driftEvent.count({ where: { shopId } }), "the request looked for drift").toBe(0);

      // The worker's turn: the edit is drift, the mirror learns it, the delivery is handled.
      await drain(shopId);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: edited } })).livePrice).toBe(137n);
      const drift = await prisma.driftEvent.findFirstOrThrow({ where: { shopId, variantGid: edited } });
      expect(drift).toMatchObject({ campaignId, observedPrice: 137n, resolution: "PENDING" });
      const handled = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } });
      expect(handled.status).toBe("PROCESSED");
      expect(handled.processedAt).not.toBeNull();
      expect(handled.payload, "a handled delivery kept its body, prices and all").toEqual({});
    });
  });

  it("answers a delivery for a shop it has never recorded, and refuses one it cannot verify", async () => {
    const stranger = `chaos-811-unknown-${Date.now()}.myshopify.com`;
    const id = webhookId("unknown");
    const response = await post(signed(stranger, "products/update", { id: 1, admin_graphql_api_id: "gid://shopify/Product/1", updated_at: new Date().toISOString(), variants: [] }, id));
    expect(response.status).toBe(200);
    expect(rung).toEqual([]);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } })).toMatchObject({
      shopId: null,
      shopDomain: stranger,
      status: "PROCESSED",
      payload: {},
    });

    const forgedId = webhookId("forged");
    const refused = await post(signed(stranger, "products/update", { id: 2 }, forgedId, webhookSignature("something else", SECRET))).catch(
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);
    expect(await prisma.webhookEvent.count({ where: { webhookId: forgedId } })).toBe(0);
    await prisma.webhookEvent.deleteMany({ where: { shopDomain: stranger } });
  });

  it("handles a redelivered id once: while its first delivery waits, after a failed try, and after it is done", async () => {
    await withChaos("webhook-queue-redelivery", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      let failures = 0;
      const mirror = watchMirror(() =>
        failures-- > 0 ? Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" }) : null,
      );

      // Delivered, and delivered again before the worker has looked: one row, two deliveries.
      const first = webhookId("again");
      const body = productAt(chaos, variantGids[0], "2.41", new Date(Date.now() + 60_000));
      await post(signed(domain, "products/update", body, first));
      await post(signed(domain, "products/update", body, first));
      expect(await prisma.webhookEvent.count({ where: { webhookId: first } })).toBe(1);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: first } })).attempts).toBe(2);
      await drain(shopId);
      expect(mirror.upserted.filter((gid) => gid === variantGids[0]), "a redelivery was handled twice").toHaveLength(1);

      // And again after it was handled: acknowledged, not rung, not handled.
      rung.length = 0;
      await post(signed(domain, "products/update", body, first));
      expect(rung).toEqual([]);
      await drain(shopId);
      expect(mirror.upserted.filter((gid) => gid === variantGids[0])).toHaveLength(1);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: first } })).attempts).toBe(3);

      // A first try that fails is retried, and a redelivery meanwhile is the same delivery.
      const second = webhookId("retried");
      const other = productAt(chaos, variantGids[1], "3.59", new Date(Date.now() + 60_000));
      await post(signed(domain, "products/update", other, second));
      failures = 1;
      await expect(drain(shopId)).rejects.toThrow(/connection pool/);
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: second } })).toMatchObject({
        status: "RECEIVED",
        processAttempts: 1,
        failureReason: expect.stringMatching(/connection pool/),
      });
      await post(signed(domain, "products/update", other, second));
      await drain(shopId);
      expect(mirror.upserted.filter((gid) => gid === variantGids[1]), "the retried delivery was handled more than once").toHaveLength(1);
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: second } })).toMatchObject({
        status: "PROCESSED",
        attempts: 2,
        failureReason: null,
      });
    });
  });

  it("drops a 120-write self-echo storm in the worker: no mirror work, no drift, no enrolment, and the merchant's one edit in it still counts", async () => {
    const PRODUCTS = 120;
    await withChaos("webhook-queue-echo-storm", { catalog: { products: PRODUCTS, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      // Variants in the campaign's scope that it never priced -- another run wrote them, as a
      // revert's handover does. A merchant's edit to one would enrol it; Anchor's must not (#805).
      const joined = Array.from({ length: 5 }, (_, i) => ({
        variantGid: `gid://shopify/ProductVariant/811-joined-${i}`,
        productGid: `gid://shopify/Product/811-joined-${i}`,
      }));
      await prisma.variantIndex.createMany({
        data: joined.map(({ variantGid, productGid }) => ({ shopId, variantGid, productGid, title: variantGid, price: 5_000n, currency: "USD", status: "ACTIVE" as const, tags: ["chaos"] })),
      });
      await prisma.priceSurfaceEntry.createMany({
        data: joined.map(({ variantGid }) => ({ shopId, variantGid, surfaceKind: "BASE" as const, priceListGid: "", currency: "USD", livePrice: 5_000n })),
      });
      for (const { variantGid, productGid } of joined) productOf.set(variantGid, productGid);
      await recordWriteIntents(shopId, joined.map(({ variantGid }) => ({ variantGid, price: 4_000n, compareAt: "leave" as const })));

      const mirror = watchMirror();
      const stamp = new Date(Date.now() + 60_000);
      // The merchant's edit, last in the storm and to a product the run's echoes leave alone,
      // so every echo is handled while the campaign is still Active and could have enrolled.
      const edited = variantGids[7];
      const echoes = [
        ...variantGids.filter((gid) => gid !== edited).map((gid) => productAt(chaos, gid, chaos.fake.priceOf(gid)!, stamp)),
        ...joined.map(({ variantGid }) => productAt(chaos, variantGid, "40.00", stamp)),
      ];
      const responses = await Promise.all(echoes.map((payload, i) => post(signed(domain, "products/update", payload, webhookId(`echo-${i}`)))));
      responses.push(await post(signed(domain, "products/update", productAt(chaos, edited, "1.37", new Date(stamp.getTime() + 1_000)), webhookId("merchant"))));

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(rung).toHaveLength(echoes.length + 1);
      expect(new Set(rung.map(({ ref }) => ref.shopId))).toEqual(new Set([shopId]));
      expect(mirror.upserted, "the route wrote the mirror").toEqual([]);
      expect(await prisma.webhookEvent.count({ where: { shopId, status: "RECEIVED" } })).toBe(echoes.length + 1);

      // More than one turn's worth, so the drain yields to other shops in between.
      expect(await drain(shopId), "a storm bigger than a turn was drained in one").toBeGreaterThan(1);

      expect(await prisma.driftEvent.count({ where: { shopId } }), "an echo was taken for a merchant's edit").toBe(1);
      expect((await prisma.driftEvent.findFirstOrThrow({ where: { shopId } })).variantGid).toBe(edited);
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.enrollPendingAt, "Anchor's own writes enrolled variants").toBeNull();
      expect(campaign.enrollPendingVariantGids).toEqual([]);
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "campaign.auto_enroll" } })).toBe(0);
      // No mirror work for an echo: not a version read, not an upsert. Only the merchant's.
      expect(mirror.versioned, "an echo went past the echo check").toEqual([productOf.get(edited)]);
      expect(mirror.upserted).toEqual([edited]);
      expect(mirror.surfaced).toEqual([edited]);
      expect(await prisma.webhookEvent.count({ where: { shopId, status: "PROCESSED" } })).toBe(echoes.length + 1);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: edited } })).livePrice).toBe(137n);
    });
  });

  it("handles only the newest of a product's waiting deliveries, never an older one over it", async () => {
    await withChaos("webhook-queue-coalesce", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      const [busy, tied, deleted] = variantGids;
      const mirror = watchMirror();
      const base = Date.now() + 60_000;
      const at = (minute: number) => new Date(base + minute * 60_000);

      // Ten edits to one product inside a minute's worth of stamps, arriving out of order.
      const edits = Array.from({ length: 10 }, (_, i) => ({ minute: i, price: `1.${String(11 + i)}` }));
      for (const edit of [3, 9, 0, 5, 1, 8, 2, 7, 4, 6].map((i) => edits[i])) {
        await post(signed(domain, "products/update", productAt(chaos, busy, edit.price, at(edit.minute / 10)), webhookId("busy")));
      }
      // Two in the same second: a stamp cannot say which is later, so neither is let go.
      // Apart by a few milliseconds, so their arrival order is the one asserted on.
      await post(signed(domain, "products/update", productAt(chaos, tied, "2.22", at(1)), webhookId("tied-a")));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await post(signed(domain, "products/update", productAt(chaos, tied, "2.23", at(1)), webhookId("tied-b")));
      // An update and then the product's deletion: the deletion is all there is to handle.
      await post(signed(domain, "products/update", productAt(chaos, deleted, "3.33", at(2)), webhookId("doomed")));
      await post(signed(domain, "products/delete", { id: chaos.fixture.productOf.get(deleted)!.split("/").pop() }, webhookId("delete")));

      await drain(shopId);

      expect(mirror.upserted.filter((gid) => gid === busy), "more than the newest of ten was handled").toHaveLength(1);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: busy } })).livePrice).toBe(120n);
      expect((await prisma.driftEvent.findFirstOrThrow({ where: { shopId, variantGid: busy } })).observedPrice, "drift saw an older edit").toBe(120n);
      expect(mirror.upserted.filter((gid) => gid === tied)).toHaveLength(2);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: tied } })).livePrice).toBe(223n);
      expect(mirror.upserted.filter((gid) => gid === deleted)).toHaveLength(0);
      expect((await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: deleted } })).deletedAt).not.toBeNull();
      expect(await prisma.webhookEvent.count({ where: { shopId, status: { not: "PROCESSED" } } })).toBe(0);

      // An older edit arriving after the newest was handled is still older: the mirror's own
      // version rule keeps it out, in the worker as in the request.
      await post(signed(domain, "products/update", productAt(chaos, busy, "1.15", at(0.4)), webhookId("late")));
      await drain(shopId);
      expect(mirror.upserted.filter((gid) => gid === busy)).toHaveLength(1);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: busy } })).livePrice).toBe(120n);
    });
  });

  it("sets a delivery that fails every time aside, and the shop's others go on", async () => {
    await withChaos("webhook-queue-poison", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, variantGids, productOf } = chaos.fixture;
      const { MAX_PROCESS_ATTEMPTS } = await import("../../app/services/webhook-queue.server");
      const [poison, fine] = variantGids;
      watchMirror((productGid) => (productGid === productOf.get(poison) ? new Error("this payload breaks the handler") : null));

      await post(signed(domain, "products/update", productAt(chaos, poison, "9.99", new Date(Date.now() + 60_000)), webhookId("poison")));
      await post(signed(domain, "products/update", productAt(chaos, fine, "8.88", new Date(Date.now() + 60_000)), webhookId("fine")));

      // The queue retries the job; each try costs the poison an attempt, not its shop a turn.
      for (let attempt = 1; attempt < MAX_PROCESS_ATTEMPTS; attempt++) {
        await expect(drain(shopId)).rejects.toThrow(/breaks the handler/);
      }
      await drain(shopId);

      // By product, not by arrival: two posts in one millisecond tie on `receivedAt`.
      const rows = await deliveriesOf(shopId);
      const broken = rows.find((row) => row.subjectGid === productOf.get(poison))!;
      expect(broken).toMatchObject({ status: "FAILED", processAttempts: MAX_PROCESS_ATTEMPTS });
      expect(broken.failureReason).toMatch(/breaks the handler/);
      expect(rows.find((row) => row.subjectGid === productOf.get(fine))).toMatchObject({ status: "PROCESSED" });
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: fine } })).livePrice).toBe(888n);
    });
  });

  it("rings a shop whose deliveries were persisted and never drained", async () => {
    await withChaos("webhook-queue-stranded", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      const { ringStrandedWebhooks, STRANDED_AFTER_MS } = await import("../../app/services/webhook-queue.server");
      const queue = { enqueue: async (name: QueueName, ref: JobRef) => void rung.push({ name, ref }), depths: async () => ({}) as never, close: async () => {} };

      await post(signed(domain, "products/update", productAt(chaos, variantGids[0], "4.44", new Date()), webhookId("stranded")));
      // Only this shop's rings: another scenario's fixture left behind on failure may be waiting too.
      const ringsForThisShop = () => rung.filter(({ ref }) => ref.shopId === shopId);
      rung.length = 0;
      await ringStrandedWebhooks(queue);
      expect(ringsForThisShop(), "a delivery still inside its window was taken for lost").toEqual([]);

      await prisma.webhookEvent.updateMany({ where: { shopId }, data: { receivedAt: new Date(Date.now() - STRANDED_AFTER_MS - 1_000) } });
      expect(await ringStrandedWebhooks(queue)).toBeGreaterThanOrEqual(1);
      expect(ringsForThisShop()).toEqual([{ name: "webhooks", ref: { shopId } }]);
    });
  });

  it("with no worker queue, handles the delivery in the request as before, and a redelivery once", async () => {
    await withChaos("webhook-queue-inline", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      queueMode = "none";
      const mirror = watchMirror();
      const [variantGid] = variantGids;
      pending = {
        shop: domain,
        topic: "PRODUCTS_UPDATE",
        payload: productAt(chaos, variantGid, "1.37", new Date(Date.now() + 60_000)),
      };
      const id = webhookId("inline");
      const unsigned = () =>
        new Request("https://example.invalid/webhooks/products", {
          method: "POST",
          headers: { "X-Shopify-Webhook-Id": id, "X-Shopify-Topic": "products/update", "X-Shopify-Shop-Domain": domain },
        });

      expect((await post(unsigned())).status).toBe(200);
      expect(libraryCalls, "the inline path did not authenticate through the library").toBe(1);
      expect(rung).toEqual([]);
      expect((await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid } })).livePrice).toBe(137n);
      expect(await prisma.driftEvent.findFirstOrThrow({ where: { shopId, variantGid } })).toMatchObject({ campaignId, observedPrice: 137n });
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } })).toMatchObject({ status: "PROCESSED", attempts: 1, payload: {} });

      // Shopify sends it again -- the answer was lost after the work was done.
      expect((await post(unsigned())).status).toBe(200);
      expect(mirror.upserted, "a redelivery was handled again").toEqual([variantGid]);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: id } })).attempts).toBe(2);
    });
  });
});
