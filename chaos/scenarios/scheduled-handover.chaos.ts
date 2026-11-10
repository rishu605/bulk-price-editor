/**
 * The scheduler hands its starts and ends to the worker, and a shop's runs never overlap (#809).
 *
 * The tick ran each due transition inside itself: one 100k-variant scheduled apply held every
 * other shop's starts and ends behind it, and the leader lock lapsed meanwhile (#808's
 * comment). Now the tick hands each to a run lane and returns; the worker's job asks the
 * schedule again, applies, and -- when the end came while it applied -- reverts in the same job
 * (#1053). With no queue the tick still runs it itself, under the shop's lease like any run.
 *
 * Driven through the real `tick` and the worker's `handleJob`. The queue is a recorder, so the
 * scenario chooses when the worker takes the job. A slow apply is a bulk operation the fake
 * holds running, which is what 100k variants look like from here.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { takeShopLease } from "../../app/services/shop-lease.server";
import type { QueueRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { fixtureAdminClient, withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

// Four variants sent the way 102,132 would be, as one bulk operation the fake holds running.
let forceBulk = false;
vi.mock("../../app/lib/planning/write-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/planning/write-path")>();
  return {
    ...actual,
    selectWritePath: (rowCount: number, options?: Parameters<typeof actual.selectWritePath>[1]) =>
      forceBulk && rowCount > 0
        ? { path: "bulk" as const, rowCount, reason: "sent in bulk, as a catalogue this size would be" }
        : actual.selectWritePath(rowCount, options),
  };
});

/** The worker's queue, as a recorder: the scenario runs each job when it chooses. */
const handed: Array<{ name: QueueName; ref: JobRef }> = [];
const recorder: QueueRuntime = {
  async enqueue(name, ref) {
    handed.push({ name, ref });
  },
  async depths() {
    return {} as never;
  },
  async close() {},
};

async function worker(job: { name: QueueName; ref: JobRef }) {
  const { handleJob } = await import("../../app/worker/handlers.server");
  return handleJob(job.name, job.ref);
}

/** Waits for `check` to hold, asking every 100 ms. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The fixture campaign with a window, SCHEDULED. */
async function scheduled(chaos: ChaosContext, window: { startAt: Date; endAt: Date; revertBufferMinutes: number }) {
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt: window.startAt,
      endAt: window.endAt,
      schedule: {
        ...(campaign.schedule as object),
        kind: "window",
        startAt: window.startAt.toISOString(),
        endAt: window.endAt.toISOString(),
        revertBufferMinutes: window.revertBufferMinutes,
      } as never,
    },
  });
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const dollars = (minor: number) => (minor / 100).toFixed(2);

describe("chaos: the scheduler's starts and ends are the worker's jobs", () => {
  it("hands a due start to the small-run lane and returns at once; the worker's job applies it, once", async () => {
    await withChaos("scheduled-handover", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      endpoint = chaos.server.endpoint();
      forceBulk = false;
      handed.length = 0;
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const now = Date.now();
      await scheduled(chaos, { startAt: new Date(now - 60_000), endAt: new Date(now + 24 * 60 * 60_000), revertBufferMinutes: 5 });

      // At least: the tick reads every shop, and another scenario's fixture may be due too.
      const result = await tick(new Date(), recorder);
      expect(result.queued).toBeGreaterThanOrEqual(1);
      expect(result.applied, "the tick applied it itself").toBe(0);
      expect(await statusOf(campaignId), "the tick claimed it rather than handing it over").toBe("SCHEDULED");
      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);
      // Three variants is seconds of writing: the small-run lane. The campaign in its own field.
      const mine = handed.filter((job) => job.ref.shopId === shopId);
      expect(mine).toEqual([{ name: "execution-small", ref: { shopId, scheduled: campaignId, revert: false } }]);
      expect(mine[0].ref).not.toHaveProperty("campaignId");

      // The next tick, while the job waits, hands it over again; the queue's key absorbs it.
      handed.length = 0;
      await tick(new Date(), recorder);
      expect(handed.filter((job) => job.ref.shopId === shopId)).toEqual(mine);

      // Delivered twice -- the first ring and the second -- it applies once.
      await worker(mine[0]);
      await worker(mine[0]);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      const runs = await prisma.campaignRun.findMany({ where: { campaignId } });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "APPLY", status: "COMPLETED" });
      expect(runs[0].occurrenceKey).toMatch(/^APPLY@/);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(Math.round(baseline.get(gid)! * 0.9)));
      await chaos.expectHonest(runs[0].id);
      expect(await prisma.shopLease.count({ where: { shopId } }), "the job kept its shop's lease").toBe(0);
    });
  });

  it("reverts in the same job when the end came while its start applied (#1053), and holds the shop throughout", async () => {
    await withChaos(
      "scheduled-handover-late",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, pollsBeforeComplete: 1_000 },
      async (chaos) => {
        endpoint = chaos.server.endpoint();
        forceBulk = true;
        handed.length = 0;
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
        const now = Date.now();
        // Started a minute ago; reverting is due seconds from now, with the apply in Shopify's hands.
        await scheduled(chaos, { startAt: new Date(now - 60_000), endAt: new Date(now + 63_000), revertBufferMinutes: 1 });

        await tick(new Date(), recorder);
        const job = handed.find((entry) => entry.ref.shopId === shopId)!;
        expect(job).toBeDefined();
        const running = worker(job);
        await until(async () => (await prisma.bulkOperationRecord.count({ where: { shopId } })) > 0, "Shopify to accept the apply");

        // The shop is the job's while it applies: named for the campaign, so a run waiting
        // behind it can say whose run it waits for.
        expect(await prisma.shopLease.findMany({ where: { shopId }, select: { kind: true, campaignId: true } })).toEqual([
          { kind: "run", campaignId },
        ]);
        // The end comes due while it applies. A tick meanwhile hands nothing over and writes nothing.
        await until(async () => Date.now() > now + 4_000, "the end to come due", 10_000);
        handed.length = 0;
        await tick(new Date(), recorder);
        expect(handed.filter((entry) => entry.ref.shopId === shopId), "the end was handed over under the apply").toEqual([]);
        expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } })).toBe(0);

        chaos.fake.finishBulkOnNextPoll();
        await running;
        expect(await statusOf(campaignId), "the end waited for another tick").toBe("COMPLETED");
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(baseline.get(gid)!));
        const runs = await prisma.campaignRun.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
        expect(runs.map((run) => [run.kind, run.status])).toEqual([
          ["APPLY", "COMPLETED"],
          ["REVERT", "COMPLETED"],
        ]);
        await chaos.expectHonest(runs[1].id);
        expect(await prisma.shopLease.count({ where: { shopId } })).toBe(0);
      },
    );
  });

  it("with no queue, runs a due start itself -- unless another of the shop's runs holds it, when it waits for the next tick", async () => {
    await withChaos("scheduled-shop-busy", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      endpoint = chaos.server.endpoint();
      forceBulk = false;
      const { shopId, campaignId } = chaos.fixture;
      const now = Date.now();
      await scheduled(chaos, { startAt: new Date(now - 60_000), endAt: new Date(now + 24 * 60 * 60_000), revertBufferMinutes: 5 });

      // Another of the shop's runs is writing.
      const other = await takeShopLease(shopId, "run", { campaignId: "another-campaign" });
      expect(other).not.toBeNull();
      try {
        const waiting = await tick(new Date());
        expect(waiting.waiting).toBeGreaterThanOrEqual(1);
        expect(await statusOf(campaignId), "it was claimed with the shop busy").toBe("SCHEDULED");
        expect(await prisma.campaignRun.count({ where: { campaignId } }), "a run was written beside the shop's other").toBe(0);
      } finally {
        await other!.release();
      }

      // The shop is free: the next tick starts it, as the tick always did.
      const started = await tick(new Date());
      expect(started.applied).toBeGreaterThanOrEqual(1);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      expect(await prisma.shopLease.count({ where: { shopId } }), "the tick kept the shop's lease").toBe(0);
    });
  });
});
