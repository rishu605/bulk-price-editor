/**
 * A revert too large for one request goes to the worker (#772), as a row first (#808).
 *
 * Apply has always been bounded by the inline budget; revert was not, because the check
 * sat inside `if (!options.revert)`. A revert from the campaign page or Flow ran inline
 * however large it was, and past Railway's five-minute proxy limit the request is cut off
 * while the writes carry on with nobody reading the result.
 *
 * Since D29 the limit is rows as well as time, and a run handed over is a QUEUED run row
 * before it is a job: with Redis away, or no Redis at all, the request still answers
 * "queued", writes nothing, and the worker's tick runs it. The limit here is ten rows over a
 * twenty-variant fixture, so the scenario stays small; what is under test is the hand-over.
 *
 * The web queue is replaced by a recorder, and the recorded job is then run through the
 * worker's own handler -- the same code the worker process runs. `adminClientForShop` is
 * replaced because the fixture shop has no Shopify session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { PAGE_INLINE } from "../../app/lib/execution/inline-budget";
import { ringQueuedRuns, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import { inlineRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
let queueMode: "ok" | "down" | "none" = "ok";

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () =>
    queueMode === "none"
      ? null
      : {
          async enqueue(name: QueueName, ref: JobRef) {
            if (queueMode === "down") throw new Error("ECONNREFUSED");
            enqueued.push({ name, ref });
          },
          async depths() {
            return {};
          },
          async close() {},
        },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

beforeEach(() => {
  enqueued.length = 0;
  queueMode = "ok";
});

const CATALOG = { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 } as const;

async function onSale(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  await chaos.expectHonest((await chaos.apply()).runId);
  return new Map(chaos.fixture.variantGids.map((gid) => [gid, chaos.fake.priceOf(gid)]));
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/** Ten rows, so the twenty-variant fixture is the worker's. */
const SMALL = { ...PAGE_INLINE, rows: 10 };

/** The worker's tick, past the moment a queued row counts as waiting. */
async function workerTick(chaos: ChaosContext, queue = inlineRuntime(handler)) {
  const now = new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000);
  return ringQueuedRuns(queue, handler, { now, shopId: chaos.fixture.shopId });
}
async function handler(name: QueueName, ref: JobRef) {
  const { handleJob } = await import("../../app/worker/handlers.server");
  return handleJob(name, ref);
}

describe("chaos: a revert too large for one request", () => {
  it("is handed to the worker, not written inline, and the worker finishes it", async () => {
    await withChaos("queued-revert", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      const sale = await onSale(chaos);

      const outcome = await chaos.revert({ inline: SMALL, actor: "staff@example.com" });

      expect(outcome.queued, "a 20-variant revert ran inline past a 10-row limit").toBe(true);
      expect(outcome.messages[0]).toMatch(/covers 20 variants, more than the 10.*background worker is reverting it/);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "written inline anyway").toBe(sale.get(gid));
      expect(await statusOf(campaignId), "not claimed, so a second press could queue a second revert").toBe("REVERTING");
      // The row first: the run the page follows, and the one the job names (#808).
      const queued = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, status: "QUEUED" } });
      expect(queued).toMatchObject({ kind: "REVERT", plannedRows: 20, startedAt: null });
      expect(outcome.runId).toBe(queued.id);
      expect(enqueued).toEqual([
        {
          name: "execution",
          ref: { shopId: chaos.fixture.shopId, campaignId, runId: queued.id, revert: true, claimedFrom: "ACTIVE", actor: "staff@example.com" },
        },
      ]);

      // A second press is refused by the row, names it, and queues nothing more.
      const again = await chaos.revert({ actor: "chaos", inline: SMALL });
      expect(again.deferredTo).toBe(queued.id);
      expect(again.messages[0]).toMatch(/already queued to be reverted over 20 variants, waiting for the background worker/);
      expect(enqueued).toHaveLength(1);

      // The worker runs the job, as the row it was handed.
      await handler(enqueued[0].name, enqueued[0].ref);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(await prisma.campaignRun.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: "COMPLETED", verifiedRows: 20 });
      // A job rung twice runs once: the second finds the row taken and touches nothing.
      await handler(enqueued[0].name, enqueued[0].ref);
      expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } })).toBe(1);
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", "")), `${gid} not reverted`).toBe(baseline.get(gid));
      }
    });
  });

  it("is still queued when Redis does not take the job, and the worker's tick runs it, not the request (#808)", async () => {
    await withChaos("queued-revert-down", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      const sale = await onSale(chaos);
      queueMode = "down";

      const outcome = await chaos.revert({ actor: "chaos", inline: SMALL });

      // It used to refuse: "the background worker could not be reached". The row is the truth.
      expect(outcome.queued).toBe(true);
      expect(outcome.refused).toBeUndefined();
      expect(await statusOf(campaignId)).toBe("REVERTING");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "written in the request").toBe(sale.get(gid));

      // The worker's tick, with its own queue down too: it rings the row, the queue does not
      // take it, and the tick runs it there and then.
      const down = {
        async enqueue() {
          throw new Error("ECONNREFUSED");
        },
        async depths() {
          return {} as never;
        },
        async close() {},
      };
      expect(await workerTick(chaos, down)).toBe(1);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
      // And never twice: the next tick finds nothing waiting.
      expect(await workerTick(chaos, down)).toBe(0);
    });
  });

  it("with no worker queue at all, is queued rather than run in the request, and the worker's tick runs it (#808)", async () => {
    await withChaos("queued-revert-fits", CATALOG, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      const sale = await onSale(chaos);

      // No queue to hand it to. Before D29 a revert ran here, in the request.
      queueMode = "none";
      const outcome = await chaos.revert({ actor: "chaos", inline: SMALL });
      expect(outcome.queued).toBe(true);
      expect(outcome.verified).toBe(0);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale.get(gid));
      expect(enqueued).toHaveLength(0);

      // Not rung before it has had its moment to reach a queue.
      expect(await ringQueuedRuns(inlineRuntime(handler), handler, { shopId: chaos.fixture.shopId })).toBe(0);
      // The worker with no Redis runs everything inline: in its tick.
      expect(await workerTick(chaos)).toBe(1);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
    });
  });

  it("does not queue a revert that fits in the request", async () => {
    await withChaos("queued-revert-small", CATALOG, async (chaos) => {
      await onSale(chaos);
      const outcome = await chaos.revert({ actor: "chaos", inline: PAGE_INLINE });
      expect(outcome.queued).toBeUndefined();
      expect(outcome.verified).toBe(20);
      expect(enqueued).toHaveLength(0);
    });
  });
});
