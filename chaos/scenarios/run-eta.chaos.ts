/**
 * What the campaign page's poll says about time left while a run writes (#820).
 *
 * Driven through the real run and the real status route, with the run held part-way: the
 * client the run is given asks the route, as the page does every five seconds, before it
 * passes a price write on to the store. The run is waiting on that answer, so the ledger is
 * exactly what a page would read at that moment.
 *
 * What this pins is the half of the estimate that holds on today's run path: it says
 * nothing it has not observed. A sync run settles its base rows in one batch, once every
 * product is written and read back, so part-way through, the ledger shows none written and
 * the poll gives no estimate. A revert that keeps edits ledgers them SKIPPED before any
 * price is sent, and they are not read as a run nearly done. Once a run records its rows as
 * it writes them (D28), the first case is where the estimate appears after 5% and not before.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { runEta } from "../../app/lib/campaigns/run-eta";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let shop = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop } }) },
}));

interface Polled {
  status: string | null;
  eta: string | null;
}

/** What the page's poll hears. */
async function poll(campaignId: string): Promise<Polled> {
  const { loader } = await import("../../app/routes/app.campaign-status");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaign-status?id=${campaignId}`),
    params: {},
    context: {},
  } as never)) as Polled;
}

/** The run's base rows by status, and its own row, as they stand. */
async function standing(campaignId: string) {
  const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
  const rows = await prisma.variantChange.groupBy({
    by: ["status"],
    where: { runId: run.id, surfaceKind: "BASE" },
    _count: { _all: true },
  });
  return { run, byStatus: Object.fromEntries(rows.map((row) => [row.status, row._count._all])) };
}

/** A client that, at the listed price writes, holds the run while `onWrite` looks. */
function holding(chaos: ChaosContext, at: number[], onWrite: (write: number) => Promise<void>): AdminClient {
  const inner = chaosAdminClient(chaos.server.endpoint());
  let writes = 0;
  return {
    async request(query, variables) {
      if (isVariantWrite(query)) {
        writes++;
        if (at.includes(writes)) await onWrite(writes);
      }
      return inner.request(query, variables);
    },
  };
}

describe("chaos: the time left while a run writes", () => {
  it("gives no estimate part-way through a sync run whose ledger shows nothing written yet", async () => {
    await withChaos("run-eta-sync", { catalog: { products: 40, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, domain } = chaos.fixture;
      shop = domain;
      const seen: Array<{ write: number; polled: Polled; standing: Awaited<ReturnType<typeof standing>> }> = [];

      const client = holding(chaos, [1, 30], async (write) => {
        seen.push({ write, polled: await poll(campaignId), standing: await standing(campaignId) });
      });
      const outcome = await runCampaign(shopId, campaignId, client, { actor: "chaos" });
      expect(outcome.clean).toBe(true);
      expect(seen.map((entry) => entry.write)).toEqual([1, 30]);

      for (const { write, polled, standing: now } of seen) {
        expect(polled.status, `write ${write}`).toBe("APPLYING");
        expect(now.run.writePath, "the sync branch is the one read").toBe("SYNC");
        // Why there is nothing to say: 29 products written and not one row settled. The run
        // records them in one batch after the read-back.
        expect(now.byStatus, `write ${write}`).toEqual({ PENDING: 40 });
        expect(polled.eta, `write ${write}: an estimate from rows the ledger does not show`).toBeNull();
      }

      // Over, the poll has nothing to estimate either.
      expect(await poll(campaignId)).toMatchObject({ status: "ACTIVE", eta: null });
    });
  });

  it("speaks once 5% of the run's rows show written, and not before", async () => {
    // The ledger as a run that records its rows as it writes them would leave it (D28): rows
    // settled here by hand, part-way, and the run started five minutes ago. The run's own
    // results replace them when it records them.
    await withChaos("run-eta-settling", { catalog: { products: 40, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, domain, variantGids } = chaos.fixture;
      shop = domain;
      const settle = async (count: number) => {
        const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
        await prisma.campaignRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
        await prisma.variantChange.updateMany({
          where: { runId: run.id, variantGid: { in: variantGids.slice(0, count) } },
          data: { status: "VERIFIED", appliedAt: new Date(), verifiedAt: new Date() },
        });
      };
      const heard: Record<number, Polled> = {};

      const client = holding(chaos, [2, 12], async (write) => {
        // One row of forty (2.5%), then ten (25%).
        await settle(write === 2 ? 1 : 10);
        heard[write] = await poll(campaignId);
      });
      expect((await runCampaign(shopId, campaignId, client, { actor: "chaos" })).clean).toBe(true);

      expect(heard[2].eta, "an estimate from one row in forty").toBeNull();
      // Ten rows in five minutes, thirty to go: fifteen.
      expect(heard[12].eta).toBe("about 15 minutes left");
      expect(await poll(campaignId)).toMatchObject({ status: "ACTIVE", eta: null });
    });
  });

  it("does not read the prices a revert keeps as rows it has written", async () => {
    await withChaos("run-eta-kept", { catalog: { products: 40, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, domain, variantGids } = chaos.fixture;
      shop = domain;
      expect((await chaos.apply()).clean).toBe(true);

      // A tenth kept as edited: ledgered SKIPPED as the revert starts, before any price is sent.
      const kept = variantGids.slice(0, 4);
      const held: Array<{ polled: Polled; standing: Awaited<ReturnType<typeof standing>>; at: Date }> = [];
      const client = holding(chaos, [2], async () => {
        held.push({ polled: await poll(campaignId), standing: await standing(campaignId), at: new Date() });
      });
      const outcome = await runCampaign(shopId, campaignId, client, { actor: "chaos", revert: true, skipVariantGids: kept });
      expect(outcome.clean).toBe(true);
      expect(held).toHaveLength(1);

      const [{ polled, standing: now, at }] = held;
      expect(polled.status).toBe("REVERTING");
      expect(now.byStatus).toEqual({ SKIPPED: 4, PENDING: 36 });
      expect(polled.eta, "the kept prices were read as a tenth of the revert done in a second").toBeNull();

      // And they would have been: counted as written, the same moment reads as nearly done.
      const naive = runEta(
        { path: "SYNC", rows: 40, written: 4, startedAt: now.run.startedAt, heartbeatAt: now.run.heartbeatAt },
        at,
      );
      expect(naive, "the check above would pass without the exclusion it is for").not.toBeNull();
    });
  });
});
