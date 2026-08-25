/**
 * The database connection dropped mid-run.
 *
 * A failover, a pod restart, a connection pool reset -- however it happens, the run
 * loses its database halfway through, after the ledger is committed and while prices
 * are still being written. The dangerous outcome is not the crash; it is a storefront
 * carrying changes the ledger never recorded, which cannot be explained, attributed
 * or reverted.
 *
 * So the assertion is invariant I4 in its most demanding form: no matter where the
 * connection was cut, every price the store accepted has a ledger row behind it. That
 * ordering is what makes the recovery afterwards possible at all.
 *
 * The connection is cut with a proxy rather than by stopping Postgres, so the outage
 * is targeted -- this run loses its connection while the harness keeps the one it
 * needs to find out what happened.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { ledgerOf, withChaos } from "../harness/scenario";
import { TcpProxy, targetOf, through } from "../harness/tcp-proxy";
import { convergenceViolations } from "../harness/verdict";
import { startApply, waitForWrites } from "../harness/worker-process";

const LATER = () => new Date(Date.now() + 60 * 60_000);

describe("chaos: the database connection drops mid-run", () => {
  it("leaves no unledgered write, and resumes to the identical state", async () => {
    await withChaos(
      "postgres-drop",
      { catalog: { products: 14, variantsPerProduct: 2 }, percent: -30 },
      async (chaos) => {
        const clean = await chaos.apply();
        await chaos.expectHonest(clean.runId);
        const reference = chaos.livePrices();
        await chaos.revert();

        // The child gets its own path to Postgres so the outage hits only the run.
        const target = targetOf(process.env.DATABASE_URL!, 5432);
        const proxy = new TcpProxy(target.host, target.port);
        await proxy.start();

        try {
          const child = startApply({
            endpoint: chaos.server.endpoint(),
            shopId: chaos.fixture.shopId,
            campaignId: chaos.fixture.campaignId,
            databaseUrl: through(process.env.DATABASE_URL!, proxy),
          });

          const before = chaos.fake.writeLog.length;
          await waitForWrites(chaos.server, before + 8);

          // Mid-writes, with rows committed and more still to come.
          proxy.cut();
          await child.finished.catch(() => null);
        } finally {
          await proxy.stop();
        }

        const runId = await chaos.latestRunId("APPLY");
        const rows = await ledgerOf(runId);

        // The invariant. Every write the store accepted was ledgered first -- if the
        // cut had landed between the API call and the ledger write, this is where it
        // would show, and there would be a price live that we could not account for.
        const ledgered = new Set(rows.map((row) => row.variantGid));
        for (const write of chaos.fake.writeLog) {
          expect(ledgered.has(write.variantGid)).toBe(true);
        }

        // Database back. The scheduler is what notices the run stopped talking.
        await tick(LATER());

        const reclaimed = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } });
        expect(reclaimed.status).toBe("PARTIAL");

        const verdict = await chaos.expectHonest(runId);
        expect(verdict.outcome).toBe("partial");

        const resumed = await chaos.apply({ resume: true });
        await chaos.expectHonest(resumed.runId);
        expect(resumed.clean).toBe(true);

        expect(convergenceViolations(reference, chaos.livePrices())).toEqual([]);
      },
    );
  });
});
