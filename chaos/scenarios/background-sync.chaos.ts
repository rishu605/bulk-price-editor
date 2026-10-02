/**
 * A catalogue sync runs in the worker, and Home follows it (#801).
 *
 * Home's Sync button ran the whole sync inside its request -- on a 102,132-variant store
 * about twelve minutes, cut off by the proxy at five with a bare "502" while the sync
 * carried on, and a page saying "Not yet synced" that offered two more sync buttons.
 *
 * Driven through Home's own action and the worker's own handler. The catalogue read, the
 * shop basics and the market read are replaced -- the fake store models neither the bulk
 * query nor the shop object, and each step is tested on its own elsewhere -- so each can
 * look at what the shop row says while it runs. Baseline capture is the real one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { syncStateOf } from "../../app/services/sync-job.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
/** What the shop row said each step was, read from inside that step. */
const seen: Record<string, unknown> = {};
let marketsFail = false;
let marketsProblem: string | null = null;
/** How long the market step takes, to see the heartbeat move while it is silent. */
let marketsMs = 0;

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      enqueued.push({ name, ref });
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

const phaseOf = async (domain: string) => {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain } });
  return { phase: shop.syncPhase, progress: shop.syncProgress };
};

vi.mock("../../app/services/catalog-sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/catalog-sync.server")>()),
  fetchShopBasics: async () => ({ currency: "USD", timezone: "Europe/London", developerStore: true }),
}));

vi.mock("../../app/services/catalog-bulk-sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/catalog-bulk-sync.server")>()),
  syncCatalogViaBulk: async (_client: unknown, shopId: string, _currency: string, options: { onProgress?: (p: { variants: number; products: number }) => Promise<void> }) => {
    await options.onProgress?.({ variants: 3, products: 3 });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    seen.catalogue = await phaseOf(shop.domain);
    return { products: 3, variants: 3, orphans: 0, malformed: 0, written: 3, bulkOperationGid: null, errors: [] };
  },
}));

vi.mock("../../app/services/markets-sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/markets-sync.server")>()),
  syncMarkets: async (_client: unknown, shopId: string) => {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    seen.markets = await phaseOf(shop.domain);
    if (marketsMs > 0) {
      const before = (await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).syncHeartbeatAt!;
      await new Promise((resolve) => setTimeout(resolve, marketsMs));
      const after = (await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).syncHeartbeatAt!;
      seen.heartbeatMoved = after.getTime() > before.getTime();
    }
    if (marketsFail) throw new Error("Shopify said no.");
    return { priceLists: 0, relative: 0, entries: 0, errors: marketsProblem ? [marketsProblem] : [] };
  },
}));

beforeEach(() => {
  enqueued.length = 0;
  marketsFail = false;
  marketsProblem = null;
  marketsMs = 0;
  for (const key of Object.keys(seen)) delete seen[key];
});

async function press(intent: string) {
  const { action } = await import("../../app/routes/app._index");
  const body = new FormData();
  body.set("intent", intent);
  const started = Date.now();
  const response = await action({
    request: new Request("https://example.invalid/app", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
  const answer = (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string };
  return { ...answer, ms: Date.now() - started };
}

async function runTheJob() {
  const { handleJob } = await import("../../app/worker/handlers.server");
  const job = enqueued.shift()!;
  await handleJob(job.name, job.ref);
}

const shopOf = (chaos: ChaosContext) => prisma.shop.findUniqueOrThrow({ where: { id: chaos.fixture.shopId } });

describe("chaos: Sync catalogue on Home", () => {
  it("answers at once, runs in the worker step by step, and offers no second sync meanwhile", async () => {
    await withChaos("background-sync", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      // A store that has never captured anything: the capture is real work.
      await prisma.baseline.deleteMany({ where: { shopId } });

      const answer = await press("sync");
      expect(answer.message).toMatch(/Syncing your catalogue in the background/);
      expect(answer.ms, "the request waited for the sync").toBeLessThan(2_000);
      expect(syncStateOf(await shopOf(chaos))).toMatchObject({ running: true, phase: "queued", text: "Waiting for the background worker" });
      expect(enqueued).toEqual([{ name: "sync", ref: { shopId, fullSync: true, actor: "staff:42" } }]);

      // A second press, a second tab: nothing more is started.
      const again = await press("sync");
      expect(again.message).toMatch(/already being synced/);
      expect(enqueued, "a second sync was queued beside the first").toHaveLength(1);

      await runTheJob();
      expect(seen.catalogue).toEqual({ phase: "catalogue", progress: { done: 3 } });
      expect(seen.markets).toMatchObject({ phase: "markets" });

      const shop = await shopOf(chaos);
      expect(syncStateOf(shop)).toEqual({ running: false, phase: null, text: null, startedAt: null, failure: null });
      // Nothing of this sync is left for the next one to show as its own.
      expect(shop.syncProgress, "the last step's count outlived the sync").toBeNull();

      // The next sync starts with no count.
      await press("sync");
      expect(syncStateOf(await shopOf(chaos)).text).toBe("Waiting for the background worker");
      enqueued.length = 0;
      expect(shop.initialSyncCompletedAt, "the sync never recorded finishing").not.toBeNull();
      expect(shop.timezone).toBe("Europe/London");
      expect(await prisma.baseline.count({ where: { shopId, supersededAt: null } })).toBe(3);
      expect(await prisma.auditLogEntry.findFirst({ where: { shopId, action: "catalogue.synced" } })).toMatchObject({ actor: "staff:42" });
    });
  });

  it("says where a sync stopped, and lets it be run again", async () => {
    await withChaos("background-sync-fails", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      // A store whose first sync fails part-way.
      await prisma.shop.update({ where: { id: chaos.fixture.shopId }, data: { initialSyncCompletedAt: null } });
      marketsFail = true;

      await press("sync");
      await expect(runTheJob(), "a failed sync looked like a finished job").rejects.toThrow(/Shopify said no/);

      const state = syncStateOf(await shopOf(chaos));
      expect(state.running).toBe(false);
      expect(state.failure).toBe(
        "The last sync stopped while reading your markets' price lists: Shopify said no. Run it again: it picks up what is already captured.",
      );
      expect((await shopOf(chaos)).initialSyncCompletedAt).toBeNull();

      // Running it again is a fresh claim, and the failure goes once it starts.
      marketsFail = false;
      const again = await press("sync");
      expect(again.message).toMatch(/in the background/);
      expect(syncStateOf(await shopOf(chaos)).failure).toBeNull();
      await runTheJob();
      expect((await shopOf(chaos)).initialSyncCompletedAt).not.toBeNull();
    });
  });

  it("says a problem that did not stop it, as the banner after a sync used to (#733)", async () => {
    await withChaos("background-sync-problem", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      marketsProblem = "Europe was not read: a catalogue import still holds the bulk queue.";

      await press("sync");
      await runTheJob();

      const shop = await shopOf(chaos);
      expect(shop.initialSyncCompletedAt, "a sync that finished was not recorded as finishing").not.toBeNull();
      expect(syncStateOf(shop).failure, "the worker swallowed the market's refusal").toBe(
        "The last sync finished, but one part did not: Europe was not read: a catalogue import still holds the bulk queue. Run it again to retry it.",
      );
    });
  });

  it("stays alive through a step that reports nothing", async () => {
    await withChaos("background-sync-alive", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      const { syncTiming } = await import("../../app/services/sync-job.server");
      syncTiming.heartbeatMs = 50;
      marketsMs = 400;
      try {
        await press("sync");
        await runTheJob();
      } finally {
        syncTiming.heartbeatMs = 30_000;
      }
      // The market read reports nothing; on a 102,132-variant store it was eight minutes of
      // it. The heartbeat moved anyway, so the sync was never taken for dead.
      expect(seen.heartbeatMoved, "a silent step left the sync looking dead").toBe(true);
      // And nothing stamped it after it ended.
      expect((await shopOf(chaos)).syncHeartbeatAt).toBeNull();
    });
  });

  it("does not let a worker that died mid-sync hold the button for good", async () => {
    await withChaos("background-sync-stale", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      const longAgo = new Date(Date.now() - 11 * 60_000);
      await prisma.shop.update({
        where: { id: chaos.fixture.shopId },
        data: { syncStartedAt: longAgo, syncPhase: "baselines", syncHeartbeatAt: longAgo, syncProgress: { done: 5_000, total: 102_132 } },
      });
      expect(syncStateOf(await shopOf(chaos)).failure).toMatch(/stopped responding while capturing baselines/);

      const answer = await press("sync");
      expect(answer.message, "a dead sync's claim refused a new one").toMatch(/in the background/);
      expect(enqueued).toHaveLength(1);
      // The dead sync's count is not the new one's.
      expect(syncStateOf(await shopOf(chaos)).text).toBe("Waiting for the background worker");
    });
  });
});
