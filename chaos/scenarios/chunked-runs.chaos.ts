/**
 * A large run is written in chunks, a turn on the large lane each (#809, D34).
 *
 * #809's third criterion: a 100k-variant run becomes jobs of 5,000 rows that interleave with
 * other shops' work, and its chunks survive a worker restart -- the run picks up at the next
 * unverified chunk without planning again. This machine cannot write 100k, so the chunk is
 * 500 rows here (`RUN_CHUNK_ROWS`, mocked) and the runs 1,500: three chunks each, on Shopify's
 * bulk path as the real ones are. Everything else is the real thing:
 *
 * - **Two shops' large runs interleave.** A real BullMQ worker on this suite's Redis, with the
 *   real lanes and caps: two shops' chunked applies take both `execution` slots, and a third
 *   shop's run on the same lane, pressed after them, finishes while both are still writing --
 *   between two of their chunks, not after either.
 * - **A worker killed mid-chunk.** A real process, SIGKILLed after Shopify accepted its chunk's
 *   operation and before it read it back. The reaper gives the run back to the queue, the tick
 *   rings it, and the next turn reads that operation's result file and writes the last chunk: one
 *   run, planned once, every price sent once.
 * - **A failed chunk.** Rows a chunk's operation never wrote, and a chunk whose submission
 *   Shopify answers with an error. The run ends Partial with the ledger's account of what landed,
 *   and Resume finishes it clean.
 *
 * The queues are emptied before and after, so nothing is left for a later scenario's `/healthz`.
 */

import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { reclaimStaleRuns } from "../../app/services/campaigns/reaper.server";
import { ringChunkedRuns } from "../../app/services/campaigns/queued-run.server";
import { continueChunkedRun } from "../../app/services/campaigns/run.server";
import { runProgressOf } from "../../app/services/campaigns/run-eta.server";
import { startRun } from "../../app/services/campaigns/start-run.server";
import { connectionFor, redisRuntime, type QueueRuntime } from "../../app/worker/queue-runtime.server";
import { QUEUE_NAMES } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";
import { startTurn } from "../harness/worker-process";

const REDIS_URL = process.env.REDIS_URL;

/** A chunk this machine can write three of per run: the real one is 5,000. */
vi.mock("../../app/lib/execution/run-chunks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/lib/execution/run-chunks")>()),
  RUN_CHUNK_ROWS: 500,
}));

/** Every plan made for a campaign, by campaign: a chunked run plans once, in its first turn. */
const plans = vi.hoisted(() => new Map<string, number>());
vi.mock("../../app/lib/planning/plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/planning/plan")>();
  return {
    ...actual,
    planRun: (...args: Parameters<typeof actual.planRun>) => {
      const campaignId = args[0].campaignId;
      if (campaignId) plans.set(campaignId, (plans.get(campaignId) ?? 0) + 1);
      return actual.planRun(...args);
    },
  };
});

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
  if (!REDIS_URL) return;
  const connection = { ...connectionFor(REDIS_URL), maxRetriesPerRequest: null };
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
async function startWorker(): Promise<QueueRuntime> {
  const { handleJob } = await import("../../app/worker/handlers.server");
  runtime = redisRuntime(handleJob, { connection: connectionFor(REDIS_URL!), shopBusyRetryMs: 500 });
  return runtime;
}

/** Waits for `check` to hold, asking every 100 ms. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const runOf = (campaignId: string) => prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
const operationsOf = (runId: string) =>
  prisma.bulkOperationRecord.findMany({ where: { runId, kind: "MUTATION" }, orderBy: { submittedAt: "asc" } });
const ledgerCount = (runId: string, status: string) =>
  prisma.variantChange.count({ where: { runId, surfaceKind: "BASE", priceListGid: "", status: status as never } });

function useStore(chaos: ChaosContext): AdminClient {
  const client = chaosAdminClient(chaos.server.endpoint());
  clients.set(chaos.fixture.domain, client);
  return client;
}

/** Applied as a merchant pressing Apply on the campaign page would. */
const press = (chaos: ChaosContext, client: AdminClient) => startRun(chaos.fixture.shopId, chaos.fixture.campaignId, client, "page", { actor: "chaos" });

/** How many times Shopify was sent each of a fixture's base prices. */
function sendsOf(chaos: ChaosContext): Map<string, number> {
  const sends = new Map<string, number>();
  for (const write of chaos.fake.writeLog) {
    if (write.priceListGid !== null) continue;
    sends.set(write.variantGid, (sends.get(write.variantGid) ?? 0) + 1);
  }
  return sends;
}

/** Every variant of the fixture sent once, and none twice. */
function sentOnceEach(chaos: ChaosContext): void {
  const sends = sendsOf(chaos);
  expect(sends.size, "variants Shopify was sent").toBe(chaos.fixture.variantGids.length);
  expect([...sends.values()].filter((count) => count > 1), "prices sent twice").toEqual([]);
}

/** Takes a chunked run's turns, one after another, until its last: what the worker does between other shops' work. */
async function turnsUntilDone(chaos: ChaosContext, runId: string): Promise<number> {
  const client = chaosAdminClient(chaos.server.endpoint());
  for (let turns = 1; turns <= 20; turns++) {
    const turn = await continueChunkedRun(chaos.fixture.shopId, runId, client);
    if (turn.kind !== "continues") return turns;
  }
  throw new Error("a chunked run took more than twenty turns");
}

/** Three products' worth of variants per product, so a chunk of 500 splits products the way a real one does. */
const LARGE = { products: 500, variantsPerProduct: 3 };

describe.skipIf(!REDIS_URL)("chaos: a large run is written in chunks that interleave with other shops' runs (#809, D34)", () => {
  beforeEach(async () => {
    recorded.length = 0;
    clients.clear();
    plans.clear();
    await emptyQueues();
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await emptyQueues();
  });

  it("finishes a third shop's run on the large lane between two other shops' chunks, while both still write", async () => {
    await withChaos("chunked-interleave-a", { catalog: LARGE, percent: -10, pollsBeforeComplete: 2 }, async (a) => {
      await withChaos("chunked-interleave-b", { catalog: LARGE, percent: -10, pollsBeforeComplete: 2 }, async (b) => {
        // Three hundred products one variant each: the sync path, one job, and too long for the
        // small-run lane (`smallRun`), so it waits on `execution` behind the chunked runs.
        await withChaos("chunked-interleave-c", { catalog: { products: 300, variantsPerProduct: 1 }, percent: -10 }, async (c) => {
          await startWorker();
          const [clientA, clientB, clientC] = [useStore(a), useStore(b), useStore(c)];

          // Two shops' 1,500-variant applies: planned once each, then a chunk a turn, each
          // chunk's operation held at Shopify for two polls. Both `execution` slots are theirs.
          expect((await press(a, clientA)).queued).toBe(true);
          expect((await press(b, clientB)).queued).toBe(true);
          const [runA, runB] = [(await runOf(a.fixture.campaignId)).id, (await runOf(b.fixture.campaignId)).id];
          await until(async () => (await operationsOf(runA)).length > 0 && (await operationsOf(runB)).length > 0, "both runs' first chunks");

          // The third shop's run, on the same lane, pressed while both write.
          const reply = await press(c, clientC);
          expect(reply.queued).toBe(true);
          const runC = await runOf(c.fixture.campaignId);
          expect((runC.request as { small?: boolean }).small, "on the large lane").toBeUndefined();
          await until(async () => (await runOf(c.fixture.campaignId)).status !== "QUEUED", "the worker to take the third shop's run");

          // The worker took it while both large runs were still writing: it had a slot between two
          // of their chunks, rather than after either had finished. One job a run, it waited for one
          // of them to end.
          for (const run of [runA, runB]) {
            const row = await prisma.campaignRun.findUniqueOrThrow({ where: { id: run } });
            expect(row.status, "a large run had finished first").toBe("EXECUTING");
            expect(await ledgerCount(run, "PENDING"), "chunks left to write").toBeGreaterThan(0);
          }
          const waitedC = recorded.find((entry) => entry.name === "run.wait_ms" && entry.labels.shopId === c.fixture.shopId);
          expect(waitedC?.labels.lane).toBe("execution");

          await until(async () => (await statusOf(c.fixture.campaignId)) === "ACTIVE", "the third shop's run to finish", 300_000);
          const doneC = await runOf(c.fixture.campaignId);
          expect(doneC).toMatchObject({ status: "COMPLETED", verifiedRows: 300 });
          await c.expectHonest(doneC.id);

          // A large run between chunks reads as the run it is: one count across its chunks, the
          // shop held by the run, nothing reaped.
          await until(async () => ((await runOf(a.fixture.campaignId)).writtenRows ?? 0) >= 500, "A's first chunk to be read back");
          const [phase, lease, stillA] = [
            (await runProgressOf(a.fixture.shopId, a.fixture.campaignId)).phase,
            await prisma.shopLease.findFirst({ where: { shopId: a.fixture.shopId, kind: "run" }, select: { holder: true } }),
            await runOf(a.fixture.campaignId),
          ];
          if (stillA.status === "EXECUTING") {
            expect(phase).toMatch(/^Writing (500|1,000) of 1,500 prices$/);
            expect(lease).toEqual({ holder: `run:${runA}` });
          }

          // Both finish, each one run of three chunks, written once, verified clean.
          await until(
            async () => (await statusOf(a.fixture.campaignId)) === "ACTIVE" && (await statusOf(b.fixture.campaignId)) === "ACTIVE",
            "both large runs to finish",
            240_000,
          );
          for (const [chaos, runId] of [[a, runA], [b, runB]] as const) {
            const row = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId }, include: { chunk: true } });
            expect(row).toMatchObject({ status: "COMPLETED", plannedRows: 1_500, verifiedRows: 1_500, failedRows: 0, writtenRows: 1_500 });
            expect(row.chunk).toMatchObject({ size: 500, turns: 4, restarts: 0, waitingSince: null });
            expect(await operationsOf(runId), "one bulk operation a chunk").toHaveLength(3);
            expect(plans.get(chaos.fixture.campaignId), "planned once").toBe(1);
            expect(await prisma.campaignRun.count({ where: { campaignId: chaos.fixture.campaignId } }), "one run").toBe(1);
            sentOnceEach(chaos);
            await chaos.expectHonest(runId);
            // One entry for the run's end, as a run written in one job has.
            const finished = await prisma.auditLogEntry.findMany({
              where: { shopId: chaos.fixture.shopId, entity: "Campaign", entityId: chaos.fixture.campaignId, action: "campaign.transition" },
              select: { after: true },
            });
            const ends = finished.map((entry) => (entry.after as { reason?: string } | null)?.reason ?? "").filter((reason) => reason.startsWith("apply finished"));
            expect(ends).toEqual(["apply finished: 1500 verified, 0 failed"]);
            expect(await prisma.shopLease.count({ where: { shopId: chaos.fixture.shopId } }), "the run kept its shop").toBe(0);
          }
        });
      });
    });
  }, 600_000);

  it("carries on at the next unverified chunk after a worker is killed mid-chunk, without planning again or sending a price twice", async () => {
    await withChaos("chunked-worker-killed", { catalog: LARGE, percent: -10 }, async (chaos) => {
      const client = useStore(chaos);
      const { shopId, campaignId } = chaos.fixture;

      // Its first turn, as the worker's job takes it: planned and ledgered, nothing written.
      const first = await chaos.apply({ turns: true });
      expect(first).toMatchObject({ continues: true, planned: 1_500, verified: 0 });
      const runId = first.runId;
      expect(plans.get(campaignId)).toBe(1);
      expect(await ledgerCount(runId, "PENDING")).toBe(1_500);

      // Its first chunk.
      expect((await continueChunkedRun(shopId, runId, client)).kind).toBe("continues");
      expect(await ledgerCount(runId, "VERIFIED")).toBe(500);
      const firstChunk = await prisma.variantChange.findMany({
        where: { runId, status: "VERIFIED" },
        select: { id: true, verifiedAt: true },
        orderBy: { id: "asc" },
      });

      // Its second, in a worker killed once Shopify has accepted the chunk's operation and before
      // it reads it back: Shopify holds the operation running until the scenario says.
      chaos.fake.pollsBeforeComplete = 1_000;
      const child = startTurn({ endpoint: chaos.server.endpoint(), shopId, runId });
      try {
        await until(async () => (await operationsOf(runId)).length === 2 && (await ledgerCount(runId, "WRITING")) === 500, "the second chunk to reach Shopify", 90_000);
      } finally {
        child.kill();
      }
      expect(await child.finished, "the worker finished its turn before it was killed").toBeNull();

      // The state a worker restarted mid-run leaves: the run in a turn nobody is in, its chunk
      // sent and unread, its campaign still the run's.
      const killed = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId }, include: { chunk: true } });
      expect(killed.status).toBe("EXECUTING");
      expect(killed.chunk?.waitingSince).toBeNull();
      expect(await statusOf(campaignId)).toBe("APPLYING");

      // The reaper, once the turn has gone quiet, gives the run back to the queue rather than
      // reclaiming it as Partial: nobody has to press Resume.
      const reaped = await reclaimStaleRuns(new Date(Date.now() + 60 * 60_000), undefined, { shopId });
      expect(reaped).toMatchObject({ reclaimed: 0, restarted: [runId] });
      expect(await prisma.runChunk.findUniqueOrThrow({ where: { runId } })).toMatchObject({ restarts: 1, waitingSince: expect.any(Date) });
      expect((await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("EXECUTING");
      expect(await statusOf(campaignId)).toBe("APPLYING");

      // Shopify finishes the operation the dead worker sent. A worker comes back, and the tick
      // rings the run.
      chaos.fake.finishBulkOnNextPoll();
      const { handleJob } = await import("../../app/worker/handlers.server");
      const queue = await startWorker();
      // After the reaper's sweep, which was an hour ahead so the turn had gone quiet.
      expect(await ringChunkedRuns(queue, handleJob, { now: new Date(Date.now() + 2 * 60 * 60_000), shopId })).toBe(1);
      await until(async () => (await statusOf(campaignId)) === "ACTIVE", "the run to finish");

      // One run, planned once; the dead worker's chunk read back from Shopify's result file
      // rather than sent again, and the last chunk written; the first chunk never touched again.
      const done = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId }, include: { chunk: true } });
      expect(done).toMatchObject({ status: "COMPLETED", verifiedRows: 1_500, failedRows: 0 });
      expect(done.chunk).toMatchObject({ turns: 4, restarts: 1, waitingSince: null });
      expect(await prisma.campaignRun.count({ where: { campaignId } }), "a second run").toBe(1);
      expect(plans.get(campaignId), "planned again").toBe(1);
      expect(await operationsOf(runId), "a chunk sent twice").toHaveLength(3);
      expect(
        await prisma.variantChange.findMany({
          where: { id: { in: firstChunk.map((row) => row.id) } },
          select: { id: true, verifiedAt: true },
          orderBy: { id: "asc" },
        }),
        "the first chunk was written again",
      ).toEqual(firstChunk);
      sentOnceEach(chaos);
      await chaos.expectHonest(runId);
      expect(await prisma.shopLease.count({ where: { shopId } }), "the run kept its shop").toBe(0);
    });
  }, 300_000);
});

describe("chaos: a failed chunk leaves a chunked run Partial, and Resume finishes it clean (#809, D34)", () => {
  beforeEach(() => plans.clear());

  it("goes on past a chunk whose operation wrote only some of its rows, ends Partial, and Resume writes only those", async () => {
    await withChaos("chunked-rows-failed", { catalog: LARGE, percent: -10 }, async (chaos) => {
      const client = chaosAdminClient(chaos.server.endpoint());
      const { shopId, campaignId } = chaos.fixture;
      const first = await chaos.apply({ turns: true });
      expect(first.continues).toBe(true);
      const runId = first.runId;

      // The first chunk lands; the second's operation stops after a hundred of its lines.
      expect((await continueChunkedRun(shopId, runId, client)).kind).toBe("continues");
      chaos.fake.bulkFailsAfterLines = 100;
      expect((await continueChunkedRun(shopId, runId, client)).kind).toBe("continues");
      // The third lands, and the run ends: Partial, with the rows Shopify never wrote said so.
      const last = await continueChunkedRun(shopId, runId, client);
      expect(last.kind).toBe("finished");
      const outcome = last.kind === "finished" ? last.outcome : null;
      // About two hundred rows -- the lines past the hundredth -- were never written. Products
      // straddle a chunk's edge, so not exactly.
      const unwritten = await ledgerCount(runId, "APPLIED");
      expect(unwritten).toBeGreaterThan(150);
      expect(unwritten).toBeLessThan(250);
      expect(outcome).toMatchObject({ clean: false, verified: 1_500 - unwritten, unverified: unwritten, failed: 0 });

      expect(await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "PARTIAL",
        verifiedRows: 1_500 - unwritten,
      });
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      expect((await chaos.expectHonest(runId)).outcome).toBe("partial");

      // Resume: those rows and nothing else -- fewer than a chunk, so written in one call.
      const resumed = await chaos.apply({ resume: true, turns: true });
      expect(resumed.continues).toBeUndefined();
      expect(resumed).toMatchObject({ clean: true, verified: unwritten });
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      await chaos.expectHonest(resumed.runId);
      // Between them, the two runs read back every variant once.
      const landed = await prisma.variantChange.findMany({
        where: { runId: { in: [runId, resumed.runId] }, surfaceKind: "BASE", status: { in: ["VERIFIED", "CLAMPED"] } },
        select: { variantGid: true },
      });
      expect(new Set(landed.map((row) => row.variantGid)).size).toBe(1_500);
      expect(landed).toHaveLength(1_500);
      sentOnceEach(chaos);
    });
  }, 300_000);

  it("stops at a chunk whose submission Shopify answers with an error, Partial with what landed, and Resume finishes it in chunks", async () => {
    // 2,100 variants, so what is left after the first chunk is still more than the bulk threshold
    // (1,000): a resume of fewer goes down the sync path, a product at a time, in one call.
    await withChaos("chunked-turn-throws", { catalog: { products: 700, variantsPerProduct: 3 }, percent: -10 }, async (chaos) => {
      const client = chaosAdminClient(chaos.server.endpoint());
      const { shopId, campaignId } = chaos.fixture;
      const runId = (await chaos.apply({ turns: true })).runId;
      expect((await continueChunkedRun(shopId, runId, client)).kind).toBe("continues");

      // Shopify answers the second chunk's submission with a server error, every time.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("bulkOperationRunMutation") }]);
      await expect(continueChunkedRun(shopId, runId, client)).rejects.toThrow(/This apply stopped part-way\. 500 of 2,100 prices were changed/);
      chaos.heal();

      // Partial, as a run written in one job ends when it throws after writing: what landed is
      // verified, the rest never sent, and the history says how far it got.
      expect(await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "PARTIAL", verifiedRows: 500 });
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      expect(await ledgerCount(runId, "PENDING")).toBe(1_600);
      expect((await chaos.expectHonest(runId)).outcome).toBe("partial");
      // Its turn is over for good: a job delivered late finds nothing to write.
      expect((await continueChunkedRun(shopId, runId, client)).kind).toBe("over");

      // Resume: 1,600 outstanding is four chunks, so it is a chunked run of its own, and the five
      // hundred that landed are left as they are.
      const resumed = await chaos.apply({ resume: true, turns: true });
      expect(resumed).toMatchObject({ continues: true, planned: 1_600 });
      expect(await turnsUntilDone(chaos, resumed.runId)).toBe(4);
      expect(await prisma.campaignRun.findUniqueOrThrow({ where: { id: resumed.runId } })).toMatchObject({
        status: "COMPLETED",
        verifiedRows: 1_600,
      });
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      sentOnceEach(chaos);
      await chaos.expectHonest(resumed.runId);
    });
  }, 300_000);
});
