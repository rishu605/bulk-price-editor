/**
 * The three Flow actions keep Flow's contract (#773).
 *
 * Flow waits ten seconds for a status, shows a 4xx without resending it, and resends a
 * 5xx for 36 hours. The actions ran campaigns sized for five minutes inside those ten
 * seconds, answered 200 to every refusal, and let deterministic throws become 5xx.
 *
 * Driven through the routes' own actions. `authenticate.flow` is replaced (no signed
 * request), the web queue is a recorder whose jobs are then run by the worker's own
 * handler, and Flow's inline limit is lowered to 10 so a 20-variant sale counts as large.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; properties: Record<string, string>; admin?: unknown } = { shop: "", properties: {} };
let endpoint = "";
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    flow: async () => ({ session: { shop: pending.shop }, payload: { properties: pending.properties }, admin: pending.admin }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async () => chaosAdminClient(endpoint),
    // The route hands Flow's `admin` to this; in the scenario that admin is the chaos client.
    toAdminClient: (admin: unknown) =>
      (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

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

vi.mock("../../app/services/flow/flow-answer.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/flow/flow-answer.server")>()),
  FLOW_INLINE_ROWS: 10,
}));

beforeEach(() => {
  enqueued.length = 0;
});

const ROUTES = {
  "start-campaign": () => import("../../app/routes/flow.actions.start-campaign"),
  "end-campaign": () => import("../../app/routes/flow.actions.end-campaign"),
  "capture-baselines": () => import("../../app/routes/flow.actions.capture-baselines"),
};

async function flow(action: "start-campaign" | "end-campaign" | "capture-baselines", chaos: ChaosContext, properties: Record<string, string>) {
  endpoint = chaos.server.endpoint();
  pending = { shop: chaos.fixture.domain, properties, admin: { __chaos: chaosAdminClient(endpoint) } };
  const { action: handler } = await ROUTES[action]();
  const started = Date.now();
  const response = (await handler({
    request: new Request(`https://example.invalid/flow/actions/${action}`, { method: "POST" }),
    params: {},
    context: {},
  } as never)) as Response;
  const body = (await response.json()) as { message: string };
  return { status: response.status, message: body.message, ms: Date.now() - started };
}

const activity = (shopId: string, action: string) =>
  prisma.auditLogEntry.findMany({ where: { shopId, actor: "shopify-flow", action: `flow.${action}` }, orderBy: { createdAt: "asc" } });

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
const CATALOG = { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: Flow's Start campaign", () => {
  it("answers 404 for a campaign that is not there, and records that Flow asked", async () => {
    await withChaos("flow-start-unknown", CATALOG, async (chaos) => {
      const answer = await flow("start-campaign", chaos, { "campaign-id": "no-such-campaign" });
      expect(answer.status, "a 200 told Flow it had worked").toBe(404);
      expect(answer.message).toContain('no campaign "no-such-campaign"');
      const [entry] = await activity(chaos.fixture.shopId, "start-campaign");
      expect(entry.after).toMatchObject({ outcome: "not-found", status: 404 });
    });
  });

  it("answers 4xx for a practice campaign, naming it, and writes nothing", async () => {
    await withChaos("flow-start-practice", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { schedule: { ...(campaign.schedule as object), practice: true } as never } });

      const answer = await flow("start-campaign", chaos, { "campaign-id": campaignId });

      expect(answer.status).toBe(400);
      expect(answer.message).toMatch(/^"chaos\/flow-start-practice" was not applied: .*practice campaign/);
      for (const gid of variantGids) expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
      expect((await activity(shopId, "start-campaign"))[0].after).toMatchObject({ outcome: "refused", status: 400 });
    });
  });

  it("hands a large campaign to the worker and answers at once", async () => {
    await withChaos("flow-start-large", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

      const answer = await flow("start-campaign", chaos, { "campaign-id": campaignId });

      expect(answer.status).toBe(200);
      expect(answer.message).toMatch(/background worker is applying it/);
      expect(answer.ms, "the answer waited for the writes").toBeLessThan(10_000);
      for (const gid of variantGids) expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
      expect(await statusOf(campaignId)).toBe("APPLYING");
      expect(enqueued).toEqual([{ name: "execution", ref: { shopId, campaignId, revert: false, claimedFrom: "DRAFT" } }]);
      expect((await activity(shopId, "start-campaign"))[0].after).toMatchObject({ outcome: "queued", status: 200 });

      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0].name, enqueued[0].ref);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(Math.round(baseline.get(gid)! * 0.8));
    });
  });
});

describe("chaos: Flow's End campaign", () => {
  it("answers 4xx, not a 5xx Flow would resend for 36 hours, for a campaign that cannot end", async () => {
    await withChaos("flow-end-draft", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      // A draft has nothing to revert: an invalid transition, the same on every resend.
      const answer = await flow("end-campaign", chaos, { "campaign-id": chaos.fixture.campaignId });
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.status).toBeLessThan(500);
      expect(answer.message).toMatch(/^"chaos\/flow-end-draft" was not ended: /);
    });
  });

  it("hands a large revert to the worker", async () => {
    await withChaos("flow-end-large", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      await chaos.expectHonest((await chaos.apply()).runId);

      const answer = await flow("end-campaign", chaos, { "campaign-id": campaignId });

      expect(answer.status).toBe(200);
      expect(enqueued).toEqual([{ name: "execution", ref: { shopId, campaignId, revert: true, claimedFrom: "ACTIVE" } }]);
      expect(await statusOf(campaignId)).toBe("REVERTING");
    });
  });
});

describe("chaos: Flow's Capture baselines", () => {
  it("answers 409 while a campaign is live, and 400 with no segment", async () => {
    await withChaos("flow-capture-refused", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      endpoint = chaos.server.endpoint();

      expect((await flow("capture-baselines", chaos, {})).status).toBe(400);

      await chaos.expectHonest((await chaos.apply()).runId);
      const live = await flow("capture-baselines", chaos, { "segment-id": "seg" });
      expect(live.status).toBe(409);
      expect(live.message).toMatch(/prices live.*Nothing was captured/);
      expect((await activity(shopId, "capture-baselines")).map((e) => (e.after as { status: number }).status)).toEqual([400, 409]);
    });
  });

  it("hands a large capture to the worker, which captures it", async () => {
    await withChaos("flow-capture-large", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const { createSegment } = await import("../../app/services/segments-crud.server");
      const segment = await createSegment(shopId, { name: "flow-capture", kind: "FROZEN", variantGids });

      const answer = await flow("capture-baselines", chaos, { "segment-id": segment.id });

      expect(answer.status).toBe(200);
      expect(answer.message).toMatch(/in the background/);
      expect(enqueued).toEqual([{ name: "sync", ref: { shopId, recaptureSegmentId: segment.id } }]);
      expect(await prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } })).toBe(0);

      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0].name, enqueued[0].ref);
      expect(await prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } })).toBe(variantGids.length);
    });
  });
});
