/**
 * Recapture refused in every state whose prices may be live (#708).
 *
 * Both guards on recapture -- the in-app plan's overlap check and the Flow action's
 * outright refusal -- counted `ACTIVE`, `APPLYING` and `PARTIAL` from a hand-written list.
 * The app's own definition, `PRICES_MAY_BE_LIVE`, also has HELD and REVERTING, and HELD is
 * the state drift puts a campaign in *while its sale prices stay live*. So a merchant or a
 * Flow recapturing a held campaign's variants was told "safe", and the sale prices became
 * the baseline: permanent, and compounded by every campaign afterwards.
 *
 * Driven through the Flow action itself; only `authenticate.flow` is replaced, and the web
 * queue, with a recorder whose jobs the worker's own handler runs: every capture Flow asks for
 * is the worker's since D29 (#808), which checks again before it writes.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { PRICES_MAY_BE_LIVE } from "../../app/lib/lifecycle/transitions";
import { planRecapture } from "../../app/services/recapture.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", segmentId: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    flow: async () => ({
      session: { shop: pending.shop },
      payload: { properties: { "segment-id": pending.segmentId } },
    }),
  },
}));

const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      enqueued.push({ name, ref });
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

/** Flow's Capture baselines, and the worker's run of whatever it queued. */
async function flowCapture() {
  const { action } = await import("../../app/routes/flow.actions.capture-baselines");
  await action({
    request: new Request("https://example.invalid/flow/actions/capture-baselines", { method: "POST" }),
    params: {},
    context: {},
  } as never);
  const { handleJob } = await import("../../app/worker/handlers.server");
  for (const job of enqueued.splice(0)) await handleJob(job.name, job.ref);
}

describe("chaos: recapture while a campaign's prices may be live", () => {
  it("is refused in every state PRICES_MAY_BE_LIVE names, in the app and from Flow", async () => {
    await withChaos(
      "recapture-live-states",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const { createSegment } = await import("../../app/services/segments-crud.server");
        const segment = await createSegment(shopId, {
          name: `recapture-live-${chaos.seed}`,
          kind: "FROZEN",
          variantGids,
        });
        pending = { shop: domain, segmentId: segment.id };

        const recaptured = () => prisma.baseline.count({ where: { shopId, source: "RECAPTURE" } });

        // The sale prices stay on the storefront throughout; only the campaign's state
        // moves -- which is exactly what drift does when it holds a campaign.
        for (const state of PRICES_MAY_BE_LIVE) {
          await prisma.campaign.update({ where: { id: campaignId }, data: { status: state } });

          const plan = await planRecapture(shopId, { segmentId: segment.id });
          expect(plan.risk, `${state}: the app called recapturing a live sale safe`).toBe(
            "overlaps-active-campaign",
          );
          expect(plan.confirmationPhrase).not.toBeNull();

          await flowCapture();
          expect(await recaptured(), `${state}: Flow made the sale prices the baseline`).toBe(0);
        }

        for (const gid of variantGids) {
          const current = await prisma.baseline.findFirstOrThrow({
            where: { shopId, variantGid: gid, supersededAt: null },
          });
          expect(Number(current.basePrice)).toBe(baseline.get(gid));
        }

        // The control: once the campaign is over, the same Flow request does capture. The
        // zeros above are refusals, not an action that never writes.
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETED" } });
        expect((await planRecapture(shopId, { segmentId: segment.id })).risk).toBe("safe");
        await flowCapture();
        expect(await recaptured()).toBe(variantGids.length);
      },
    );
  });
});
