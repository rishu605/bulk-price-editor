/**
 * Every run larger than the page writes while it waits is a queued job (D29, #808).
 *
 * One 102,132-variant apply on anchor-perf ran inside its request and held the web process's
 * connection pool for minutes; every shop's pages went blank (#803). Now the campaign page
 * writes a run of at most `MAX_INLINE_ROWS` variants itself, and everything else -- and
 * everything Flow starts -- is a QUEUED run row the request writes before it answers, which
 * the worker picks up and the page follows.
 *
 * Driven through the campaign page's own action, the status route its poll reads, Flow's
 * Start and End actions, the worker's own handler and its tick's ring. Replaced:
 * `authenticate` (no Shopify session), `adminClientForShop` and `toAdminClient` (the fake
 * store), the web queue (a recorder, or a Redis that never answers), and `loadCandidates`,
 * which is wrapped so the run can be held while it plans.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { MAX_INLINE_ROWS } from "../../app/lib/execution/inline-budget";
import { HEARTBEAT_EVERY_MS, reclaimStaleRuns, STALE_AFTER_MS } from "../../app/services/campaigns/reaper.server";
import { ringQueuedRuns, RUN_ENQUEUE_TIMEOUT_MS, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import type { QueueRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, type ChaosSpec, withChaos } from "../harness/scenario";

let shop = "";
let endpoint = "";
/** The client the worker's run gets: the fake store, held where a scenario says. */
let workerClient: AdminClient | null = null;

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop }, sessionToken: { sub: "42" }, admin: chaosAdminContext(endpoint) }),
    flow: async () => ({ session: { shop }, payload: { properties: flowProperties }, admin: { __chaos: chaosAdminClient(endpoint) } }),
  },
}));
let flowProperties: Record<string, string> = {};

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => (domain === shop ? workerClient : null),
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
/** "ok" records; "hung" is a Redis that takes the connection and never answers. */
let queueMode: "ok" | "hung" = "ok";
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => (queueMode === "hung" ? hung : recorder),
}));
const recorder: QueueRuntime = {
  async enqueue(name, ref) {
    enqueued.push({ name, ref });
  },
  async depths() {
    return {} as never;
  },
  async close() {},
};
const hung: QueueRuntime = {
  enqueue: () => new Promise<void>(() => {}),
  async depths() {
    return {} as never;
  },
  async close() {},
};

/** Called while the worker's run loads its candidates: it is PLANNING then. */
let whilePlanning: (() => Promise<void>) | null = null;
vi.mock("../../app/services/campaigns/candidates.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/candidates.server")>();
  return {
    ...actual,
    loadCandidates: async (...args: Parameters<typeof actual.loadCandidates>) => {
      const hold = whilePlanning;
      whilePlanning = null;
      if (hold) await hold();
      return actual.loadCandidates(...args);
    },
  };
});

beforeEach(() => {
  enqueued.length = 0;
  queueMode = "ok";
  whilePlanning = null;
  workerClient = null;
});

/** Over the page's fifty, so the page hands it over. */
const LARGE: ChaosSpec = { catalog: { products: MAX_INLINE_ROWS + 10, variantsPerProduct: 1 }, percent: -10, tagKit: ["SALE"] };

function useShop(chaos: ChaosContext) {
  shop = chaos.fixture.domain;
  endpoint = chaos.server.endpoint();
  workerClient = chaosAdminClient(endpoint);
}

/** Apply pressed on the campaign page, through its own action. */
async function press(campaignId: string, intent = "apply") {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const form = new FormData();
  form.set("intent", intent);
  const started = Date.now();
  const reply = (await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: form }),
    params: { id: campaignId },
    context: {},
  } as never)) as { ok: boolean; message: string };
  return { ...reply, ms: Date.now() - started };
}

/** What the page's poll hears. */
async function poll(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaign-status");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaign-status?id=${campaignId}`),
    params: {},
    context: {},
  } as never)) as { status: string | null; phase: string | null; eta: string | null };
}

async function handler(name: QueueName, ref: JobRef) {
  const { handleJob } = await import("../../app/worker/handlers.server");
  return handleJob(name, ref);
}

/** Long enough for the heartbeat's throttle to let the next count through. */
const aBeat = () => new Promise((resolve) => setTimeout(resolve, HEARTBEAT_EVERY_MS + 250));

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

describe("chaos: a large apply pressed on the campaign page", () => {
  it("answers at once, writes nothing, and the page follows the run: Queued, Planning, Writing N of M, Verifying, Done", async () => {
    await withChaos("queued-run-progress", LARGE, async (chaos) => {
      useShop(chaos);
      const { campaignId, variantGids, baseline } = chaos.fixture;

      const reply = await press(campaignId);
      expect(reply.ok).toBe(true);
      expect(reply.message).toMatch(/covers 60 variants, more than the 50 Anchor writes while the page waits\. The background worker is applying it/);
      for (const gid of variantGids) expect(Number(chaos.fake.priceOf(gid)!.replace(".", "")), "written in the request").toBe(baseline.get(gid));
      expect(await poll(campaignId)).toMatchObject({ status: "APPLYING", phase: "Queued", eta: null });

      const seen: Record<string, string | null> = {};
      whilePlanning = async () => {
        seen.planning = (await poll(campaignId)).phase;
      };
      // Held a beat before the second price write, so the count stamped with the third is the
      // next the heartbeat lets through; and at the first tag, once every price is written.
      let writes = 0;
      let tagged = false;
      const inner = workerClient!;
      workerClient = {
        async request(query, variables) {
          if (isVariantWrite(query)) {
            writes += 1;
            if (writes === 2) await aBeat();
            if (writes === 3) seen.writing = (await poll(campaignId)).phase;
          } else if (query.includes("tagsAdd") && !tagged) {
            tagged = true;
            seen.verifying = (await poll(campaignId)).phase;
          }
          return inner.request(query, variables);
        },
      };

      expect(enqueued).toHaveLength(1);
      await handler(enqueued[0].name, enqueued[0].ref);

      expect(seen).toEqual({ planning: "Planning", writing: "Writing 2 of 60 prices", verifying: "Verifying" });
      // Done: the campaign has moved on, so the poll has no run to describe and the page reloads.
      expect(await poll(campaignId)).toMatchObject({ status: "ACTIVE", phase: null, eta: null });
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } });
      expect(run).toMatchObject({ id: enqueued[0].ref.runId, status: "COMPLETED", verifiedRows: 60 });
      await chaos.expectHonest(run.id);
    });
  });

  it("is run once for two presses at the same moment, and the second is told which run holds it", async () => {
    await withChaos("queued-run-two-presses", LARGE, async (chaos) => {
      useShop(chaos);
      const { campaignId } = chaos.fixture;

      const replies = await Promise.all([press(campaignId), press(campaignId)]);

      const runs = await prisma.campaignRun.findMany({ where: { campaignId } });
      expect(runs, "two presses queued two runs").toHaveLength(1);
      expect(runs[0].status).toBe("QUEUED");
      expect(enqueued, "two jobs for one run").toHaveLength(1);
      expect(replies.every((reply) => reply.ok)).toBe(true);
      const [queued, named] = replies[0].message.includes("The background worker is applying it") ? replies : [replies[1], replies[0]];
      expect(queued.message).toMatch(/The background worker is applying it/);
      expect(named.message).toMatch(/is already queued to be applied over 60 variants, waiting for the background worker, so nothing new was started/);

      // And once it is being planned, a third press names it as that.
      whilePlanning = async () => {
        const third = await press(campaignId);
        expect(third.message).toMatch(/is already being applied over 60 variants: the background worker is planning it/);
      };
      await handler(enqueued[0].name, enqueued[0].ref);
      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(1);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
    });
  });

  it("with Redis taking the connection and never answering, answers in a second, and the worker's tick writes it", async () => {
    await withChaos("queued-run-redis-down", LARGE, async (chaos) => {
      useShop(chaos);
      const { campaignId, shopId, variantGids, baseline } = chaos.fixture;
      queueMode = "hung";

      const reply = await press(campaignId);
      expect(reply.ok).toBe(true);
      expect(reply.ms, "the request waited on Redis").toBeLessThan(RUN_ENQUEUE_TIMEOUT_MS + 5_000);
      expect(await poll(campaignId)).toMatchObject({ status: "APPLYING", phase: "Queued" });

      // A run waiting for the worker has no process to die: an hour of it is not reclaimed.
      const hourLater = new Date(Date.now() + 60 * 60_000);
      expect((await reclaimStaleRuns(hourLater, STALE_AFTER_MS, { shopId })).reclaimed).toBe(0);
      expect((await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } })).status).toBe("QUEUED");

      // The worker's own queue is the same Redis. It rings the row, waits a second for the
      // queue, and runs it in the tick.
      const rung = await ringQueuedRuns(hung, handler, { now: new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000), shopId });
      expect(rung).toBe(1);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(Math.round(baseline.get(gid)! * 0.9));
      }
    });
  });
});

describe("chaos: Flow's Start and End answer within Flow's ten seconds", () => {
  async function flow(action: "start-campaign" | "end-campaign", campaignId: string) {
    flowProperties = { "campaign-id": campaignId };
    const route = action === "start-campaign" ? await import("../../app/routes/flow.actions.start-campaign") : await import("../../app/routes/flow.actions.end-campaign");
    const started = Date.now();
    const response = (await route.action({
      request: new Request(`https://example.invalid/flow/actions/${action}`, { method: "POST" }),
      params: {},
      context: {},
    } as never)) as Response;
    return { status: response.status, message: ((await response.json()) as { message: string }).message, ms: Date.now() - started };
  }

  it("answers 200 once a run of any size is queued, and 4xx for one it refuses", async () => {
    await withChaos("queued-run-flow", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      useShop(chaos);
      const { campaignId } = chaos.fixture;

      // Three variants: the page would write it while it waited. Flow never does.
      const start = await flow("start-campaign", campaignId);
      expect(start.status).toBe(200);
      expect(start.ms).toBeLessThan(10_000);
      expect(start.message).toMatch(/Runs started from Shopify Flow are always written by the background worker/);
      expect(await prisma.campaignRun.count({ where: { campaignId, status: "QUEUED" } })).toBe(1);
      await handler(enqueued[0].name, enqueued[0].ref);
      expect(await statusOf(campaignId)).toBe("ACTIVE");

      const end = await flow("end-campaign", campaignId);
      expect(end.status).toBe(200);
      expect(end.ms).toBeLessThan(10_000);
      await handler(enqueued[1].name, enqueued[1].ref);
      expect(await statusOf(campaignId)).toBe("COMPLETED");

      // A completed campaign cannot be ended again: the same on every resend, so a 4xx.
      const again = await flow("end-campaign", campaignId);
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.status).toBeLessThan(500);
      expect(enqueued).toHaveLength(2);
    });
  });
});
