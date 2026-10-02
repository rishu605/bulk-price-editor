/**
 * One whole-campaign run at a time, held by the database (#793).
 *
 * A press of Apply took the current instant as its occurrence, so two presses -- a second
 * tab, a reload the Apply dialog invited, a Flow resend -- never collided on the run's
 * unique index, and two runs wrote the same campaign at once. #791 added a check before
 * the claim; two requests can both pass a check in the same moment, so the database now
 * refuses the second live run row outright, and the loser stands down to the winner.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/** The fake store, with every price write taking `ms`. */
function slowWrites(chaos: ChaosContext, ms: number): AdminClient {
  const inner = chaosAdminClient(chaos.server.endpoint());
  return {
    async request(query, variables) {
      if (isVariantWrite(query)) await new Promise((r) => setTimeout(r, ms));
      return inner.request(query, variables);
    },
  };
}

describe("chaos: two applies of one campaign at the same moment", () => {
  it("run once: one run row, one set of writes, and the others defer to it", async () => {
    await withChaos("one-live-run", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;

      // Four presses at once, each with its own client, as four requests would have.
      const outcomes = await Promise.all(
        [1, 2, 3, 4].map(() => runCampaign(shopId, campaignId, slowWrites(chaos, 20))),
      );

      const runs = await prisma.campaignRun.findMany({ where: { campaignId } });
      expect(runs, "two runs wrote the same campaign at once").toHaveLength(1);
      const ran = outcomes.filter((outcome) => !outcome.deferredTo);
      expect(ran).toHaveLength(1);
      for (const deferred of outcomes.filter((outcome) => outcome.deferredTo)) {
        expect(deferred.deferredTo).toBe(runs[0].id);
        expect(deferred.verified, "a deferred press wrote something").toBe(0);
      }
      await chaos.expectHonest(runs[0].id);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
    });
  });

  it("is refused by the database itself, whatever the code above it checked", async () => {
    await withChaos("one-live-run-index", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const row = (occurrenceKey: string, kind: "APPLY" | "REVERT" = "APPLY") => ({
        data: { shopId, campaignId, kind, status: "EXECUTING" as const, occurrenceKey, startedAt: new Date() },
      });

      await prisma.campaignRun.create(row("APPLY-1"));
      await expect(prisma.campaignRun.create(row("APPLY-2")), "a second live apply was allowed").rejects.toMatchObject({ code: "P2002" });
      await expect(prisma.campaignRun.create(row("REVERT-1", "REVERT")), "a revert beside a live apply was allowed").rejects.toMatchObject({ code: "P2002" });

      // A run over one variant never holds the campaign: #763 keeps it and a full run apart.
      await prisma.campaignRun.create(row("VARIANT-REVERT-gid-1"));
      // And a finished run does not count.
      await prisma.campaignRun.updateMany({ where: { campaignId, occurrenceKey: "APPLY-1" }, data: { status: "COMPLETED" } });
      await prisma.campaignRun.create(row("APPLY-3"));
    });
  });
});

describe("chaos: Revert pressed while the apply is still writing", () => {
  it("waits for the apply to finish rather than racing it", async () => {
    await withChaos("revert-mid-apply", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

      const applying = runCampaign(shopId, campaignId, slowWrites(chaos, 100));
      // Until the apply's run row exists, so the revert arrives mid-write.
      while ((await prisma.campaignRun.count({ where: { campaignId } })) === 0) await new Promise((r) => setTimeout(r, 20));

      const early = await runCampaign(shopId, campaignId, chaosAdminClient(chaos.server.endpoint()), { revert: true });
      expect(early.refused, "a revert raced the apply").toMatch(new RegExp(`"chaos/revert-mid-apply" is still being applied by a run that started`));
      expect(early.refused).toMatch(/watch it on the Runs tab/);
      expect(early.transient).toBe(true);
      expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } })).toBe(0);

      await applying;
      expect(await statusOf(campaignId)).toBe("ACTIVE");

      // Once it has finished, the same press goes through and ends the sale cleanly.
      const revert = await runCampaign(shopId, campaignId, chaosAdminClient(chaos.server.endpoint()), { revert: true });
      expect(revert.refused).toBeFalsy();
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });
});
