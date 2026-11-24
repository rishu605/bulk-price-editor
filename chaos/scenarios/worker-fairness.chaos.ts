/**
 * The worker is fair across shops (#809): a one-variant run from one shop finishes in seconds
 * while other shops' large runs hold every large-run slot, and two runs of one shop never write
 * at once.
 *
 * #809's criterion is a 100k-variant apply on one shop and a 1-variant apply on another a
 * minute later, finished in under 30 s. This machine cannot write 100k, so the large runs here
 * are 5,000 and 1,200 variants on Shopify's bulk path, held running by the fake for as long as
 * the scenario likes -- which is what an hour of Shopify's bulk queue looks like from here, and
 * keeps both `execution` slots taken whatever the size. The one-variant run is the same size as
 * the criterion's, so its 30 s is not scaled; what makes it pass is the mechanism, which the
 * scenario checks directly: it went on the small-run lane and waited seconds for a slot.
 *
 * A real BullMQ worker on this suite's Redis, consuming every queue with the real policies:
 * the lanes' slots, their caps across workers and the delayed retry of a busy shop's job are
 * BullMQ's, and a stand-in would agree with whatever this code assumed. The queues are emptied
 * before and after, so nothing is left for a later scenario's `/healthz` to read as a backlog.
 */

import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { FLOW_ACTOR } from "../../app/lib/audit/actor";
import { evaluate } from "../../app/lib/observability/alerts";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { gather } from "../../app/services/alerting.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runProgressOf } from "../../app/services/campaigns/run-eta.server";
import { startRun } from "../../app/services/campaigns/start-run.server";
import { beat } from "../../app/services/scheduler-heartbeat.server";
import { connectionFor, redisRuntime, type QueueRuntime } from "../../app/worker/queue-runtime.server";
import { QUEUE_NAMES } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const REDIS_URL = process.env.REDIS_URL;

/** Each fixture shop's fake store, by domain: the worker's runs get the shop's own. */
const clients = new Map<string, AdminClient>();
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => clients.get(domain) ?? null };
});

/** The web process's queue is the same Redis the worker below consumes. */
let runtime: QueueRuntime | null = null;
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => runtime,
}));

/** Every metric the run path records, as well as recording it. */
const recorded: Array<{ name: string; value: number; labels: Record<string, unknown> }> = [];
vi.mock("../../app/lib/telemetry/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/telemetry/metrics")>();
  return {
    ...actual,
    metric: (name: Parameters<typeof actual.metric>[0], value: number, labels: Parameters<typeof actual.metric>[2] = {}) => {
      recorded.push({ name, value, labels: { ...labels } });
      actual.metric(name, value, labels);
    },
  };
});

/** Empties every queue, its jobs and its settings, in this suite's Redis. */
async function emptyQueues(): Promise<void> {
  const connection = { ...connectionFor(REDIS_URL!), maxRetriesPerRequest: null };
  await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = new Queue(name, { connection });
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    }),
  );
}

/** A worker consuming every queue with the real policies; a busy shop's job asks again in half a second. */
async function startWorker(): Promise<void> {
  const { handleJob } = await import("../../app/worker/handlers.server");
  runtime = redisRuntime(handleJob, { connection: connectionFor(REDIS_URL!), shopBusyRetryMs: 500 });
}

/** Waits for `check` to hold, asking every 100 ms. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const runOf = (campaignId: string) => prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
const sentToShopify = async (shopId: string) => (await prisma.bulkOperationRecord.count({ where: { shopId } })) > 0;

function useStore(chaos: ChaosContext): AdminClient {
  const client = chaosAdminClient(chaos.server.endpoint());
  clients.set(chaos.fixture.domain, client);
  return client;
}

/** Applied as a merchant pressing Apply on the campaign page would. */
const press = (chaos: ChaosContext, client: AdminClient, campaignId = chaos.fixture.campaignId) =>
  startRun(chaos.fixture.shopId, campaignId, client, "page", { actor: "chaos" });

/** Held running at Shopify until the scenario says, as an hour of Shopify's bulk queue is. */
const HELD = 100_000;

describe.skipIf(!REDIS_URL)("chaos: the worker is fair across shops (#809)", () => {
  beforeEach(async () => {
    recorded.length = 0;
    clients.clear();
    await emptyQueues();
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await emptyQueues();
  });

  it("finishes a one-variant run from a third shop in seconds while two other shops' large runs hold every large-run slot", async () => {
    await withChaos("fairness-large-a", { catalog: { products: 10, variantsPerProduct: 500 }, percent: -10, pollsBeforeComplete: HELD }, async (a) => {
      await withChaos("fairness-large-c", { catalog: { products: 2, variantsPerProduct: 600 }, percent: -10, pollsBeforeComplete: HELD }, async (c) => {
        await withChaos("fairness-one-variant", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 }, async (b) => {
          await startWorker();
          const [clientA, clientC, clientB] = [useStore(a), useStore(c), useStore(b)];

          // Two shops' large applies: queued, taken by the worker, and sent to Shopify, where
          // they stay. Both of `execution`'s slots are theirs from here.
          expect((await press(a, clientA)).queued).toBe(true);
          expect((await press(c, clientC)).queued).toBe(true);
          await until(async () => (await sentToShopify(a.fixture.shopId)) && (await sentToShopify(c.fixture.shopId)), "both large runs to reach Shopify");
          expect((await runOf(a.fixture.campaignId)).status).toBe("EXECUTING");
          expect((await runOf(c.fixture.campaignId)).status).toBe("EXECUTING");

          // A third shop's one-variant apply, from Flow, so the worker writes it.
          const submitted = Date.now();
          const reply = await startRun(b.fixture.shopId, b.fixture.campaignId, clientB, "flow", { actor: FLOW_ACTOR });
          expect(reply.queued).toBe(true);
          await until(async () => (await statusOf(b.fixture.campaignId)) === "ACTIVE", "the one-variant apply to finish", 30_000);
          const took = Date.now() - submitted;

          expect(took, "the one-variant apply waited behind the large runs").toBeLessThan(30_000);
          // While both large runs still write: nothing about it waited for them to finish.
          expect((await runOf(a.fixture.campaignId)).status).toBe("EXECUTING");
          expect((await runOf(c.fixture.campaignId)).status).toBe("EXECUTING");
          expect(await statusOf(a.fixture.campaignId)).toBe("APPLYING");

          // The mechanism: it went on the small-run lane and waited seconds for its slot, from
          // the press to the worker taking it.
          const one = await runOf(b.fixture.campaignId);
          expect(one).toMatchObject({ status: "COMPLETED", verifiedRows: 1 });
          expect((one.request as { small?: boolean }).small).toBe(true);
          const waited = recorded.find((entry) => entry.name === "run.wait_ms" && entry.labels.shopId === b.fixture.shopId);
          expect(waited?.labels.lane).toBe("execution-small");
          expect(waited!.value, "it waited for a slot").toBeLessThan(10_000);
          await b.expectHonest(one.id);

          // Shopify finishes the large ones; both end clean.
          a.fake.finishBulkOnNextPoll();
          c.fake.finishBulkOnNextPoll();
          await until(
            async () => (await statusOf(a.fixture.campaignId)) === "ACTIVE" && (await statusOf(c.fixture.campaignId)) === "ACTIVE",
            "the large runs to finish",
            150_000,
          );
          await a.expectHonest((await runOf(a.fixture.campaignId)).id);
          await c.expectHonest((await runOf(c.fixture.campaignId)).id);
          for (const lane of ["execution", "execution-small"]) {
            const waits = recorded.filter((entry) => entry.name === "run.wait_ms" && entry.labels.lane === lane);
            expect(waits.length, lane).toBeGreaterThan(0);
          }
        });
      });
    });
  }, 360_000);

  it("never writes two runs of one shop at once: the second waits, visibly Queued, and starts once the first has finished", async () => {
    await withChaos("fairness-same-shop", { catalog: { products: 3, variantsPerProduct: 400 }, percent: -10, pollsBeforeComplete: HELD }, async (chaos) => {
      await startWorker();
      const client = useStore(chaos);
      const { shopId, campaignId: first } = chaos.fixture;

      // A second campaign of the same shop over one product of its own, small enough for the
      // page to write while it waits -- if the shop were free.
      const solo = { productGid: `gid://shopify/Product/${chaos.seed}-solo`, variantGid: `gid://shopify/ProductVariant/${chaos.seed}-solo-0` };
      chaos.fake.addVariant({ ...solo, price: "40.00", compareAtPrice: null });
      await prisma.variantIndex.create({
        data: { shopId, ...solo, title: "solo", price: BigInt(4000), currency: "USD", status: "ACTIVE", tags: ["solo"] },
      });
      await prisma.priceSurfaceEntry.create({
        data: { shopId, variantGid: solo.variantGid, surfaceKind: "BASE", priceListGid: "", currency: "USD", livePrice: BigInt(4000) },
      });
      await prisma.baseline.create({
        data: { shopId, variantGid: solo.variantGid, surfaceKind: "BASE", priceListGid: "", currency: "USD", basePrice: BigInt(4000), source: "INSTALL_CAPTURE" },
      });
      const second = (
        await createCampaign(shopId, {
          name: "chaos/fairness-same-shop, the second",
          priority: 800,
          rule: { kind: "percent-change", percent: -25 },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "none", byCurrency: {} },
          ast: { groups: [{ conditions: [{ field: "tag", value: "solo" }] }] },
          schedule: { kind: "manual" },
        })
      ).id;

      // The first, 1,200 variants, queued and held writing at Shopify. The shop is its run's.
      expect((await press(chaos, client)).queued).toBe(true);
      await until(() => sentToShopify(shopId), "the first run to reach Shopify");
      expect(await prisma.shopLease.findMany({ where: { shopId }, select: { kind: true, campaignId: true } })).toEqual([
        { kind: "run", campaignId: first },
      ]);

      // The second, pressed on the page: one variant, which the page would write itself, is
      // handed to the worker because the shop is busy, and says which run it waits for.
      const reply = await press(chaos, client, second);
      expect(reply.queued, reply.messages.join(" ")).toBe(true);
      expect(reply.messages[0]).toMatch(/Another run is writing this store's prices right now \("chaos\/fairness-same-shop"\), and a store's runs are written one at a time/);
      expect(chaos.fake.priceOf(solo.variantGid), "written in the request beside the first run").toBe("40.00");

      // Seconds later it is still waiting, visibly: Queued on its row and on its page, nothing
      // written, its job put back each time it asked.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const waiting = await runOf(second);
      expect(waiting.status).toBe("QUEUED");
      expect((waiting.request as { small?: boolean }).small).toBe(true);
      expect(await statusOf(second)).toBe("APPLYING");
      expect((await runProgressOf(shopId, second)).phase).toBe("Queued");
      expect(chaos.fake.priceOf(solo.variantGid)).toBe("40.00");
      expect(recorded.some((entry) => entry.name === "queue.deferred" && entry.labels.queue === "execution-small"), "its job never asked").toBe(true);
      // Behind its own shop's run is by design, and never pages.
      await beat(new Date());
      const window = await gather();
      expect(window.shopRunWaits?.filter((wait) => wait.shopId === shopId && wait.waitMs > 10_000) ?? []).toEqual([]);

      // The first finishes; the second starts after it, never beside it.
      chaos.fake.finishBulkOnNextPoll();
      await until(async () => (await statusOf(first)) === "ACTIVE", "the first run to finish", 150_000);
      await until(async () => (await statusOf(second)) === "ACTIVE", "the second run to start and finish", 30_000);
      const [one, two] = [await runOf(first), await runOf(second)];
      expect(one.status).toBe("COMPLETED");
      expect(two.status).toBe("COMPLETED");
      expect(two.startedAt!.getTime(), "the shop's runs overlapped").toBeGreaterThanOrEqual(one.finishedAt!.getTime());
      expect(chaos.fake.priceOf(solo.variantGid)).toBe("30.00");
      // Its wait, press to the worker taking it, is the whole time the first held the shop.
      const waited = recorded.find((entry) => entry.name === "run.wait_ms" && entry.labels.shopId === shopId && entry.labels.lane === "execution-small");
      expect(waited!.value).toBeGreaterThanOrEqual(3_000);
      await chaos.expectHonest(one.id);
      expect(await prisma.shopLease.count({ where: { shopId } }), "a run kept its shop's lease").toBe(0);
    });
  }, 300_000);
});

describe.skipIf(!REDIS_URL)("chaos: a small run waiting for the worker pages sooner (#809)", () => {
  let queues: Queue[] = [];

  beforeEach(async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@example.com");
    vi.stubEnv("SUPPORT_EMAIL", "support@example.com");
    vi.stubEnv("SHOPIFY_APP_URL", "");
    await emptyQueues();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const queue of queues) await queue.close();
    queues = [];
    await emptyQueues();
  });

  it("pages when a run on the small-run lane has waited a minute, where the same wait on the large lane does not", async () => {
    await beat(new Date());
    const connection = { ...connectionFor(REDIS_URL!), maxRetriesPerRequest: null };
    const small = new Queue("execution-small", { connection });
    const large = new Queue("execution", { connection });
    queues = [small, large];
    const ninetySecondsAgo = Date.now() - 90_000;
    await small.add("execution-small", { shopId: "fairness-small-shop", runId: "waiting" }, { timestamp: ninetySecondsAgo });
    await large.add("execution", { shopId: "fairness-large-shop", runId: "waiting" }, { timestamp: ninetySecondsAgo });

    const window = await gather();
    const smallWait = window.shopRunWaits?.find((wait) => wait.shopId === "fairness-small-shop");
    const largeWait = window.shopRunWaits?.find((wait) => wait.shopId === "fairness-large-shop");
    expect(smallWait).toMatchObject({ small: true });
    expect(smallWait!.waitMs).toBeGreaterThanOrEqual(90_000);
    expect(largeWait?.small).toBeUndefined();
    expect(window.executionQueueDepth, "both lanes are the backlog").toBeGreaterThanOrEqual(2);
    expect(evaluate(window).map((alert) => alert.id)).toContain("shop-run-waiting");
    // Ninety seconds on the large lane alone is a run that is next, not one that is stuck.
    const largeOnly = { ...window, shopRunWaits: [largeWait!] };
    expect(evaluate(largeOnly).map((alert) => alert.id)).not.toContain("shop-run-waiting");

    // And `/healthz` reads the small-run lane degraded at thirty seconds, naming no shop.
    const { loader } = await import("../../app/routes/healthz");
    const response = await loader();
    const body = (await response.json()) as { status: string; queues: { detail?: string } };
    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.queues.detail).toMatch(/execution-small: a job has waited \d+ s to start \(limit 30 s\)/);
    expect(JSON.stringify(body)).not.toContain("fairness-small-shop");
  });
});
