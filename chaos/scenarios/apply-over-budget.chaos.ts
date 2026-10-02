/**
 * A run from the campaign page that would outlive its request goes to the worker (#790).
 *
 * The inline limit was 120,000 variants, from 1.75 ms a variant measured on the bulk path.
 * Two costs were never in it: Shopify's bulk queue, which the run polls inside the request
 * for up to thirty minutes, and the tag kit, one `tagsAdd` per product after the prices. A
 * 3,666-variant campaign passed at 3% of the limit, and the merchant got a bare "502" at
 * five minutes while it carried on writing prices and tags for another two and a half.
 *
 * Driven through the campaign page's own action. `authenticate.admin` is replaced with an
 * admin that talks to the fake store, the web queue with a recorder whose jobs are then run
 * through the worker's own handler, and `adminClientForShop` because the fixture shop has
 * no Shopify session. The page's budget is cut to ten seconds so a fixture of a dozen
 * products can sit either side of it; the bulk path fits no budget at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: undefined,
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

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

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

vi.mock("../../app/lib/execution/inline-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/lib/execution/inline-budget")>()),
  PAGE_INLINE_BUDGET_MS: 10_000,
}));

beforeEach(() => {
  enqueued.length = 0;
});

async function press(intent: string, campaignId: string, fields: Record<string, string | string[]> = {}) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  body.set("confirmation", "apply");
  for (const [key, value] of Object.entries(fields)) {
    for (const one of [value].flat()) body.append(key, one);
  }
  const started = Date.now();
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  const answer = (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string };
  return { ...answer, ms: Date.now() - started };
}

async function runTheJob() {
  expect(enqueued, "nothing was handed to the worker").toHaveLength(1);
  const { handleJob } = await import("../../app/worker/handlers.server");
  const job = enqueued.shift()!;
  await handleJob(job.name, job.ref);
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const onSale = (chaos: ChaosContext, gid: string) => (Math.round(chaos.fixture.baseline.get(gid)! * 0.8) / 100).toFixed(2);
const atBaseline = (chaos: ChaosContext, gid: string) => (chaos.fixture.baseline.get(gid)! / 100).toFixed(2);

describe("chaos: a run from the campaign page longer than its request", () => {
  it("answers at once for a bulk-path campaign, and the worker applies it", async () => {
    await withChaos(
      "over-budget-bulk",
      { catalog: { products: 7, variantsPerProduct: 150 }, percent: -20, pollsBeforeComplete: 1 },
      async (chaos) => {
        const { campaignId, variantGids, shopId } = chaos.fixture;
        pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };

        const answer = await press("apply", campaignId);

        expect(answer.ok).toBe(true);
        expect(answer.message).toMatch(/1,050 variants, which go to Shopify as one bulk operation/);
        expect(answer.message).toMatch(/background worker is applying it/);
        expect(answer.ms, "the request waited on Shopify's bulk queue").toBeLessThan(5_000);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "written inside the request anyway").toBe(atBaseline(chaos, gid));
        expect(await statusOf(campaignId), "the page has to read Applying while the worker runs").toBe("APPLYING");
        expect(enqueued[0]).toMatchObject({ name: "execution", ref: { shopId, campaignId, revert: false, claimedFrom: "DRAFT" } });

        await runTheJob();
        expect(await statusOf(campaignId)).toBe("ACTIVE");
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(onSale(chaos, gid));
        await chaos.expectHonest((await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } })).id);
      },
    );
  });

  it("counts the tag kit: prices that fit, with one tag call a product after them, do not", async () => {
    // Twelve products: 8.7 seconds of prices fits a ten-second budget; 15.9 with tags does not.
    const catalog = { catalog: { products: 12, variantsPerProduct: 1 }, percent: -20 } as const;

    await withChaos("over-budget-untagged", catalog, async (chaos) => {
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      const answer = await press("apply", chaos.fixture.campaignId);
      expect(answer.message, "a run that fits was sent away").toMatch(/^Applied 12 variants/);
      expect(enqueued).toHaveLength(0);
    });

    await withChaos("over-budget-tagged", { ...catalog, tagKit: ["SALE"] }, async (chaos) => {
      const { campaignId, productOf, variantGids } = chaos.fixture;
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      const answer = await press("apply", campaignId);
      expect(answer.message).toMatch(/12 variants, and pricing and tagging 12 products takes about 20 seconds/);
      expect(await statusOf(campaignId)).toBe("APPLYING");

      await runTheJob();
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.tagsOf(productOf.get(gid)!)).toContain("SALE");
    });
  });

  it("carries the merchant's \"leave as it is\" to the worker, which leaves those prices alone", async () => {
    await withChaos("over-budget-keepers", { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
      await chaos.expectHonest((await chaos.apply()).runId);

      // A price the merchant changed by hand during the sale, and asked to keep.
      const kept = variantGids[0];
      chaos.fake.variants.get(kept)!.price = "7.89";

      const answer = await press("revert", campaignId, { keep: [kept] });
      expect(answer.message).toMatch(/background worker is reverting it/);
      expect(enqueued[0].ref.skipVariantGids, "the keep list was dropped on the way to the worker").toEqual([kept]);

      await runTheJob();
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(chaos.fake.priceOf(kept), "the worker overwrote the edit the merchant asked to keep").toBe("7.89");
      for (const gid of variantGids.slice(1)) expect(chaos.fake.priceOf(gid)).toBe(atBaseline(chaos, gid));
    });
  });

  it("resumes in the worker, writing only what the partial run left", async () => {
    await withChaos("over-budget-resume", { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { campaignId, variantGids, productOf } = chaos.fixture;
      pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };

      // The apply goes to the worker, and one product fails there.
      const stuck = productOf.get(variantGids[0])!;
      chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === stuck }]);
      await press("apply", campaignId);
      await runTheJob();
      expect(await statusOf(campaignId)).toBe("PARTIAL");

      // The mirror lags the store -- a webhook not yet arrived -- so a fresh apply would see
      // the nineteen verified rows still at full price and write them again. Only a resume,
      // which reads the ledger, knows they landed.
      for (const gid of variantGids) {
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId: chaos.fixture.shopId, variantGid: gid, surfaceKind: "BASE" },
          data: { livePrice: BigInt(chaos.fixture.baseline.get(gid)!) },
        });
      }

      chaos.heal();
      const answer = await press("resume", campaignId);
      expect(answer.message).toMatch(/background worker is applying it/);
      expect(enqueued[0].ref.resume, "a resume reached the worker as a fresh apply").toBe(true);

      await runTheJob();
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(onSale(chaos, gid));
      const resumed = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
      expect(
        await prisma.variantChange.count({ where: { runId: resumed.id, surfaceKind: "BASE" } }),
        "the resume rewrote rows the first run had already verified",
      ).toBe(1);
    });
  });
});
