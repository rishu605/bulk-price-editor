/**
 * A revert too large for one request goes to the worker (#772).
 *
 * Apply has always been bounded by `MAX_INLINE_ROWS`; revert was not, because the check
 * sat inside `if (!options.revert)`. A revert from the campaign page or Flow ran inline
 * however large it was, and past Railway's five-minute proxy limit the request is cut off
 * while the writes carry on with nobody reading the result.
 *
 * The web queue is replaced by a recorder, and the recorded job is then run through the
 * worker's own handler -- the same code the worker process runs. `adminClientForShop` is
 * replaced because the fixture shop has no Shopify session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
let queueMode: "ok" | "down" | "none" = "ok";

vi.mock("../../app/worker/web-queue.server", () => ({
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
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
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

describe("chaos: a revert too large for one request", () => {
  it("is handed to the worker, not written inline, and the worker finishes it", async () => {
    await withChaos("queued-revert", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      const sale = await onSale(chaos);

      const outcome = await chaos.revert({ inlineRowLimit: 10, actor: "staff@example.com" });

      expect(outcome.queued, "a 20-variant revert ran inline past a 10-row limit").toBe(true);
      expect(outcome.messages[0]).toMatch(/covers 20 variants.*background worker is reverting it/);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "written inline anyway").toBe(sale.get(gid));
      expect(await statusOf(campaignId), "not claimed, so a second press could queue a second revert").toBe("REVERTING");
      expect(enqueued).toEqual([{ name: "execution", ref: { shopId: chaos.fixture.shopId, campaignId, revert: true, claimedFrom: "ACTIVE" } }]);

      // A second press finds it claimed, and queues nothing more.
      const again = await chaos.revert({ inlineRowLimit: 10 });
      expect(again.refused).toMatch(/already being reverted/);
      expect(enqueued).toHaveLength(1);

      // The worker runs the job.
      const { handleJob } = await import("../../app/worker/handlers.server");
      await handleJob(enqueued[0].name, enqueued[0].ref);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", "")), `${gid} not reverted`).toBe(baseline.get(gid));
      }
    });
  });

  it("writes nothing and puts the campaign back when the worker cannot be reached", async () => {
    await withChaos("queued-revert-down", CATALOG, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      const sale = await onSale(chaos);
      queueMode = "down";

      const outcome = await chaos.revert({ inlineRowLimit: 10 });

      expect(outcome.refused).toMatch(/could not be reached, so nothing was written/);
      expect(await statusOf(campaignId), "the claim was kept with no job behind it").toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale.get(gid));
    });
  });

  it("still runs inline when there is no worker queue at all", async () => {
    await withChaos("queued-revert-fits", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      await onSale(chaos);

      // No queue to hand it to: a revert is never refused, so it runs here.
      queueMode = "none";
      const inline = await chaos.revert({ inlineRowLimit: 10 });
      expect(inline.queued).toBeUndefined();
      expect(inline.verified).toBe(20);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(enqueued).toHaveLength(0);
    });
  });

  it("does not queue a revert that fits in the request", async () => {
    await withChaos("queued-revert-small", CATALOG, async (chaos) => {
      await onSale(chaos);
      const outcome = await chaos.revert({ inlineRowLimit: 50 });
      expect(outcome.queued).toBeUndefined();
      expect(outcome.verified).toBe(20);
      expect(enqueued).toHaveLength(0);
    });
  });
});
