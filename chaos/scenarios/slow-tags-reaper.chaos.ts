/**
 * A run still writing its tags is not reclaimed as dead, and nothing starts a second
 * writer beside it (#791).
 *
 * The heartbeat was stamped only while prices were written. Tags come after, one call a
 * product, so a campaign tagging a few thousand products went quiet for minutes; the
 * reaper declared the live run dead, and the campaign showed Partial and offered Resume
 * while every price was verified and the tags were still landing. Resume would have
 * started a second writer on the same campaign.
 *
 * The threshold is cut to 600 ms -- the heartbeat follows it at a tenth -- and Shopify is
 * slowed to 150 ms a tag call, so six products take longer than the reaper's patience.
 * The reaper is swept the whole time, as the scheduler does on every tick.
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RUN_STALE_AFTER_MS = "600";
});

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { reclaimStaleRuns, STALE_AFTER_MS } from "../../app/services/campaigns/reaper.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const CATALOG = { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20, tagKit: ["SALE"] };

/** The fake store, with every tag call taking 150 ms. */
function slowTags(chaos: ChaosContext): AdminClient {
  const inner = chaosAdminClient(chaos.server.endpoint());
  return {
    async request(query, variables) {
      if (query.includes("tagsAdd") || query.includes("tagsRemove")) await new Promise((r) => setTimeout(r, 150));
      return inner.request(query, variables);
    },
  };
}

/** Runs to the end while the reaper sweeps beside it; returns the runs it reclaimed. */
async function sweptWhileRunning(run: Promise<unknown>) {
  let done = false;
  const reclaimed: string[] = [];
  void run.finally(() => (done = true));
  while (!done) {
    await new Promise((r) => setTimeout(r, 100));
    reclaimed.push(...(await reclaimStaleRuns(new Date())).runIds);
  }
  await run;
  return reclaimed;
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe("chaos: a run writing its tags, with the reaper sweeping", () => {
  it("runs with a threshold short enough that the tag phase outlasts it", () => {
    expect(STALE_AFTER_MS).toBe(600);
  });

  it("is not reclaimed while it applies them, and ends Active", async () => {
    await withChaos("slow-tags-apply", CATALOG, async (chaos) => {
      const { shopId, campaignId, productOf, variantGids } = chaos.fixture;
      const started = Date.now();

      const reclaimed = await sweptWhileRunning(runCampaign(shopId, campaignId, slowTags(chaos)));

      expect(Date.now() - started, "the tag phase did not outlast the threshold, so this proved nothing").toBeGreaterThan(STALE_AFTER_MS);
      expect(reclaimed, "the reaper took a live run for a dead one").toEqual([]);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.tagsOf(productOf.get(gid)!)).toContain("SALE");
    });
  });

  it("is not reclaimed while it takes them off, and ends Completed", async () => {
    await withChaos("slow-tags-revert", CATALOG, async (chaos) => {
      const { shopId, campaignId, productOf, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      // A revert's tag removal settles the apply run's tag rows, not its own: its ledger
      // is quiet throughout, and only the heartbeat says it is alive.
      const reclaimed = await sweptWhileRunning(runCampaign(shopId, campaignId, slowTags(chaos), { revert: true }));

      expect(reclaimed, "the reaper took a live revert for a dead one").toEqual([]);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.tagsOf(productOf.get(gid)!)).not.toContain("SALE");
    });
  });
});

describe("chaos: the reaper reads the ledger as well as the heartbeat", () => {
  it("leaves a quiet run alone while its rows are still changing, and reclaims it once they stop", async () => {
    await withChaos("reaper-ledger", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, campaignId, productOf, variantGids } = chaos.fixture;
      const longAgo = new Date(Date.now() - 60_000);
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });
      const run = await prisma.campaignRun.create({
        data: { shopId, campaignId, kind: "APPLY", status: "EXECUTING", occurrenceKey: "APPLY-reaper-ledger", startedAt: longAgo, heartbeatAt: longAgo },
      });
      await prisma.tagChange.create({
        data: { shopId, runId: run.id, campaignId, productGid: productOf.get(variantGids[0])!, addedTags: ["SALE"], status: "APPLIED", appliedAt: new Date() },
      });

      expect((await reclaimStaleRuns(new Date())).runIds, "a run tagging a product this second was declared dead").toEqual([]);
      expect(await statusOf(campaignId)).toBe("APPLYING");

      // The same run, a minute on with nothing written since: dead, and reclaimed.
      const later = new Date(Date.now() + 60_000);
      expect((await reclaimStaleRuns(later)).runIds).toEqual([run.id]);
      expect(await statusOf(campaignId)).toBe("PARTIAL");
    });
  });
});

describe("chaos: one writer per campaign", () => {
  it("refuses Resume, Apply and Revert while a run for the campaign has not finished", async () => {
    await withChaos("live-run-refusal", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // What #791 left behind: the campaign Partial, its run still writing.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PARTIAL" } });
      const live = await prisma.campaignRun.create({
        data: { shopId, campaignId, kind: "APPLY", status: "EXECUTING", occurrenceKey: "APPLY-live", startedAt: new Date(), heartbeatAt: new Date() },
      });

      // The same action defers to the run doing it (#793); a revert waits for it to finish.
      for (const options of [{ resume: true }, {}]) {
        const outcome = await runCampaign(shopId, campaignId, client, options);
        expect(outcome.deferredTo, `${JSON.stringify(options)} started a second writer`).toBe(live.id);
        expect(outcome.messages[0]).toMatch(/is still being applied by a run that started just now/);
      }
      const revert = await runCampaign(shopId, campaignId, client, { revert: true });
      expect(revert.refused, "a revert started beside a live apply").toMatch(/still being applied/);
      expect(revert.transient).toBe(true);
      expect(await prisma.campaignRun.count({ where: { campaignId } }), "a second run row was created").toBe(1);
      expect(await statusOf(campaignId)).toBe("PARTIAL");

      // Once it finishes, Resume goes ahead.
      await prisma.campaignRun.update({ where: { id: live.id }, data: { status: "PARTIAL", finishedAt: new Date() } });
      const resumed = await runCampaign(shopId, campaignId, client, { resume: true });
      expect(resumed.refused).toBeFalsy();
      expect(await statusOf(campaignId)).toBe("ACTIVE");
    });
  });
});
