/**
 * A campaign too large for the request that asked for it is never written there (D29, #808).
 *
 * `runCampaign` used to write prices inline, so an apply from the campaign page happened
 * during the HTTP request and died with it. Railway closes a request after five minutes with
 * no data transferred, and a React Router action sends nothing until it returns -- and the
 * proxy closing the connection does not stop `runCampaign` writing. The merchant saw an error
 * while their storefront changed anyway.
 *
 * #790 answered that with a time budget, and with no worker queue an apply past it was refused
 * and a revert ran in the request after all. D29 answers it for good: past the page's limit a
 * run is a QUEUED run row and a job, with or without a queue. So this proves the two halves
 * that replaced the refusal: nothing is written in the request, whatever is missing -- no
 * ledger row, no price moved -- and the run is not lost either, because the worker's tick
 * finds the row and writes it, to the same verified end a run in the request reaches.
 *
 * The limit is a property of the caller, not of the campaign. The worker and the scheduler
 * have no request attached, so they pass no limit and run the same campaign to completion.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { PAGE_INLINE } from "../../app/lib/execution/inline-budget";
import { ringQueuedRuns, STRANDED_RUN_AFTER_MS } from "../../app/services/campaigns/queued-run.server";
import { inlineRuntime } from "../../app/worker/queue-runtime.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

// No worker queue: the web process has nowhere to hand the job, which is the case that used
// to run a revert here and refuse an apply. CI has Redis, so without this the run below would
// put a real job on a real queue.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

/** Five rows, so the twelve-variant fixture is the worker's. What is under test is the comparison. */
const SMALL = { ...PAGE_INLINE, rows: 5 };

async function handler(name: QueueName, ref: JobRef) {
  const { handleJob } = await import("../../app/worker/handlers.server");
  return handleJob(name, ref);
}

/** The worker's tick, with no Redis of its own either: it runs what it rings. */
function workerTick(chaos: ChaosContext) {
  return ringQueuedRuns(inlineRuntime(handler), handler, {
    now: new Date(Date.now() + STRANDED_RUN_AFTER_MS + 1_000),
    shopId: chaos.fixture.shopId,
  });
}

describe("chaos: a run too large for its request is queued, never written there", () => {
  it("writes nothing in the request, and the worker's tick writes all of it", async () => {
    await withChaos(
      "inline-budget",
      { catalog: { products: 4, variantsPerProduct: 3 }, percent: -20 },
      async (ctx) => {
        endpoint = ctx.server.endpoint();
        const { shopId, campaignId } = ctx.fixture;
        const pricesBefore = ctx.livePrices();

        const queued = await ctx.apply({ actor: "chaos", inline: SMALL });

        // Not refused (#790's answer with no queue): queued, and said so with the size.
        expect(queued.refused, "an apply is never refused for its size").toBeUndefined();
        expect(queued.queued).toBe(true);
        expect(queued.messages.join(" ")).toMatch(/covers 12 variants, more than the 5.*background worker is applying it/);
        // Clean, because nothing is half-done.
        expect(queued.clean).toBe(true);
        expect(queued.verified).toBe(0);

        // Ledger before write (I4), from the other direction: no write, so no row.
        expect(await prisma.variantChange.count({ where: { shopId } }), "the request ledgered a write").toBe(0);
        for (const [gid, price] of pricesBefore) {
          expect(ctx.livePrices().get(gid), `${gid} moved inside the request`).toBe(price);
        }
        // Claimed, with its row: the page reads Applying, and a second press is refused by it.
        const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } });
        expect(run.status).toBe("QUEUED");
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("APPLYING");

        // The worker, with no deadline, runs the same campaign to a verified end.
        expect(await workerTick(ctx)).toBe(1);
        await ctx.expectHonest(run.id);
        const finished = await prisma.campaignRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(finished).toMatchObject({ status: "COMPLETED", verifiedRows: 12 });
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
      },
    );
  });

  it("never refuses a revert, however large, and never writes it in the request either", async () => {
    await withChaos(
      "inline-budget-revert",
      { catalog: { products: 4, variantsPerProduct: 3 }, percent: -20 },
      async (ctx) => {
        endpoint = ctx.server.endpoint();
        const applied = await ctx.apply();
        expect(applied.clean).toBe(true);
        const sale = ctx.livePrices();

        // A limit far below the scope. Refusing here would strand a store at 20% off because
        // it is large -- the guard causing the incident it exists to prevent.
        const reverted = await ctx.revert({ actor: "chaos", inline: SMALL });
        expect(reverted.refused, "a revert is never gated, on anything").toBeFalsy();
        expect(reverted.queued).toBe(true);
        for (const [gid, price] of sale) expect(ctx.livePrices().get(gid)).toBe(price);

        expect(await workerTick(ctx)).toBe(1);
        const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: ctx.fixture.campaignId, kind: "REVERT" } });
        expect(run).toMatchObject({ status: "COMPLETED", verifiedRows: 12 });
        await ctx.expectHonest(run.id);
      },
    );
  });
});
