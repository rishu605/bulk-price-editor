/**
 * The worker killed mid-chunk (edge case E2).
 *
 * SIGKILL, in a real child process, timed off writes the store has actually accepted.
 * Nothing else reproduces this state: `executeSync` catches per product group, so an
 * injected throw becomes an orderly per-row failure with reasons attached. A killed
 * process gets no catch block, no finally and no final ledger update -- it leaves rows
 * committed but never settled, which is a genuinely different thing to recover from.
 *
 * Two claims are under test, and the second is the one that matters:
 *
 *   The run does not sit there claiming to be applying. A process that died cannot
 *   report its own death, so something else has to notice and mark the run visibly
 *   partial. Without that, the campaign shows "Applying..." forever -- the frozen job
 *   that dominates this category's one-star reviews.
 *
 *   The resume converges on precisely the state an uninterrupted run produces. Not
 *   "succeeds" -- converges. Compared row by row against a reference run, because a
 *   resume that lands somewhere merely plausible is a resume that drifts.
 */

import { describe, expect, it } from "vitest";

import { tick } from "../../app/services/scheduler.server";
import prisma from "../../app/db.server";
import { ledgerOf, withChaos } from "../harness/scenario";
import { convergenceViolations } from "../harness/verdict";
import { killAfterWrites, startApply } from "../harness/worker-process";

/** Far enough ahead that any reasonable staleness threshold has passed. */
const LATER = () => new Date(Date.now() + 60 * 60_000);

describe("chaos: the worker is killed mid-chunk", () => {
  it("is reclaimed as visibly partial, then resumes to the identical state", async () => {
    await withChaos(
      "worker-death",
      { catalog: { products: 14, variantsPerProduct: 2 }, percent: -25 },
      async (chaos) => {
        // ------------------------------------------- the state to converge on
        const clean = await chaos.apply();
        await chaos.expectHonest(clean.runId);
        const reference = chaos.livePrices();

        // Back to baseline, so the interrupted apply has real work to do.
        await chaos.revert();

        // ------------------------------------------------------- the killing
        const child = startApply({
          endpoint: chaos.server.endpoint(),
          shopId: chaos.fixture.shopId,
          campaignId: chaos.fixture.campaignId,
        });

        const writesBefore = chaos.fake.writeLog.length;
        await killAfterWrites(chaos.server, child, writesBefore + 9);
        expect(child.killed()).toBe(true);

        const runId = await chaos.latestRunId("APPLY");

        // Ledger before write (I4): the killed process cannot have written a price it
        // had not already committed a row for.
        const afterKill = await ledgerOf(runId);
        expect(afterKill.length).toBeGreaterThan(0);
        for (const write of chaos.fake.writeLog.slice(writesBefore)) {
          expect(afterKill.some((row) => row.variantGid === write.variantGid)).toBe(true);
        }

        // ------------------------------------------------- somebody must notice
        //
        // The process is gone and took its final ledger update with it. The scheduler
        // is the thing still running, so the scheduler is what has to reclaim the run.
        await tick(LATER());

        const reclaimed = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } });
        expect(reclaimed.status).toBe("PARTIAL");
        expect(reclaimed.finishedAt).not.toBeNull();

        const campaign = await prisma.campaign.findUniqueOrThrow({
          where: { id: chaos.fixture.campaignId },
          select: { status: true },
        });
        expect(campaign.status).toBe("PARTIAL");

        const verdict = await chaos.expectHonest(runId);
        expect(verdict.outcome).toBe("partial");

        // ------------------------------------------------------- the resuming
        const resumed = await chaos.apply({ resume: true });
        await chaos.expectHonest(resumed.runId);
        expect(resumed.clean).toBe(true);

        const violations = convergenceViolations(reference, chaos.livePrices());
        expect(violations).toEqual([]);
      },
    );
  });
});
