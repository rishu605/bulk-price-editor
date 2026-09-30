/**
 * A scheduled revert that ends PARTIAL, and the ticks after it (#700).
 *
 * The occurrence key is stable -- `REVERT@<end>` -- so two ticks cannot both run one
 * window. It was also what stranded a campaign: the next tick re-claimed the PARTIAL
 * campaign into REVERTING, collided on the index with the occurrence's own *finished*
 * run, "stood down" to it, and left the campaign REVERTING with nothing behind it and
 * its sale prices live. The scheduler never looked at it again.
 *
 * Driven through the real `tick`. Only `adminClientForShop` is replaced, because the
 * fixture shop has no Shopify session; everything past it is the production path.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

/** An applied campaign whose window has closed: its scheduled revert is due now. */
async function dueRevert(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  const { campaignId } = chaos.fixture;
  const applied = await chaos.apply();
  await chaos.expectHonest(applied.runId);

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 2 * 60 * 60_000);
  const endAt = new Date(Date.now() - 60 * 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      startAt,
      endAt,
      schedule: {
        ...(campaign.schedule as object),
        kind: "window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      } as never,
    },
  });
  return `REVERT@${endAt.toISOString()}`;
}

/** Fails every price write to one product, so a run over the catalogue ends PARTIAL. */
function breakOneProduct(chaos: ChaosContext) {
  const productGid = chaos.fixture.productOf.get(chaos.fixture.variantGids[0])!;
  chaos.arm([
    {
      fault: "server-error",
      match: (query, variables) => isVariantWrite(query) && variables.productId === productGid,
    },
  ]);
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const revertRuns = (campaignId: string) =>
  prisma.campaignRun.findMany({
    where: { campaignId, kind: "REVERT" },
    orderBy: { createdAt: "asc" },
    select: { occurrenceKey: true, status: true },
  });

describe("chaos: a scheduled revert that does not finish cleanly", () => {
  it("is retried under its own key on the next tick, and completes", async () => {
    await withChaos(
      "scheduled-revert-retry",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids, baseline } = chaos.fixture;
        const base = await dueRevert(chaos);

        breakOneProduct(chaos);
        await tick(new Date());
        expect(await statusOf(campaignId)).toBe("PARTIAL");
        expect(await revertRuns(campaignId)).toEqual([{ occurrenceKey: base, status: "PARTIAL" }]);

        // The failure clears -- a Shopify hiccup, a worker that restarted mid-revert.
        chaos.heal();
        await tick(new Date());

        expect(await statusOf(campaignId), "stranded in REVERTING with nothing behind it").toBe(
          "COMPLETED",
        );
        expect(await revertRuns(campaignId)).toEqual([
          { occurrenceKey: base, status: "PARTIAL" },
          { occurrenceKey: `${base}#2`, status: "COMPLETED" },
        ]);
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }
      },
    );
  });

  it("stops after three attempts and leaves the campaign visibly PARTIAL, never REVERTING", async () => {
    await withChaos(
      "scheduled-revert-exhausted",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;
        const base = await dueRevert(chaos);
        breakOneProduct(chaos);

        for (let i = 0; i < 5; i++) {
          await tick(new Date());
          expect(await statusOf(campaignId)).toBe("PARTIAL");
        }

        expect((await revertRuns(campaignId)).map((run) => run.occurrenceKey)).toEqual([
          base,
          `${base}#2`,
          `${base}#3`,
        ]);
      },
    );
  });

  it("picks a reaped scheduled revert up again in the same tick", async () => {
    await withChaos(
      "scheduled-revert-reaped",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, shopId, variantGids, baseline } = chaos.fixture;
        const base = await dueRevert(chaos);

        // A worker that claimed the revert and died: every deploy restarts the worker.
        // The run holds the occurrence; its heartbeat stopped long ago.
        const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "REVERTING" } });
        await prisma.campaignRun.create({
          data: {
            shopId,
            campaignId,
            kind: "REVERT",
            status: "EXECUTING",
            writePath: "SYNC",
            occurrenceKey: base,
            plannedRows: variantGids.length,
            startedAt: longAgo,
            heartbeatAt: longAgo,
          },
        });

        const result = await tick(new Date());

        expect(result.reclaimed).toBe(1);
        expect(await statusOf(campaignId)).toBe("COMPLETED");
        expect((await revertRuns(campaignId)).map((run) => run.occurrenceKey)).toEqual([
          base,
          `${base}#2`,
        ]);
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }
      },
    );
  });
});
