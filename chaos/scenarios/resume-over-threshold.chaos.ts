/**
 * Resume on a large campaign whose run stopped part-way finishes it, rather than asking for
 * a word typed into a box the page does not have (#720).
 *
 * The black Resume button posts `intent=resume` and nothing else. The action put Resume
 * through the same typed confirmation as Apply, so on any campaign over the blast-radius
 * threshold it was always refused with "Type 'apply' in the confirmation box" -- and only
 * the Apply modal has one.
 *
 * The exemption is for a campaign that is PARTIAL. Posted for a draft, "resume" is an apply
 * under another name, and must still be asked for the word.
 *
 * Through the campaign page's own action, as the Resume button posts it. A campaign this
 * size goes to the worker from the page (#790), so the web queue is a recorder whose jobs
 * are run through the worker's own handler.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { BLAST_RADIUS_THRESHOLD } from "../../app/services/campaigns/types";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { fixtureAdminClient, withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
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
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, pending.endpoint) };
});

/** The Resume button's form: the intent, and no confirmation. */
async function resume(campaignId: string) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", "resume");
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string };
}

const status = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

describe("chaos: Resume on a campaign over the blast-radius threshold", () => {
  it("finishes a run that stopped part-way, and still asks for the word on a draft", async () => {
    await withChaos(
      "resume-over-threshold",
      { catalog: { products: 400, variantsPerProduct: 3 }, percent: -10, pollsBeforeComplete: 1 },
      async (chaos) => {
        const { domain, campaignId, variantGids, baseline } = chaos.fixture;
        pending = { shop: domain, endpoint: chaos.server.endpoint() };
        expect(variantGids.length).toBeGreaterThan(BLAST_RADIUS_THRESHOLD);
        const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        // A draft: "resume" is an apply by another name, and the word was not typed.
        const refused = await resume(campaignId);
        expect(refused.ok, "a 'resume' posted for a draft applied it without the word").toBe(false);
        expect(refused.message).toMatch(/apply/);
        expect(await status(campaignId)).toBe("DRAFT");
        expect(enqueued, "a refused 'resume' was handed to the worker anyway").toEqual([]);
        expect(variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid))).toBe(true);

        // The run stops early: ten products land, and more prices than the threshold are
        // still to write -- which is what Resume was asked to type the word for. (With
        // fewer left than the threshold, the plan was never over it.)
        chaos.fake.bulkFailsAfterLines = 10;
        const first = await chaos.apply();
        expect(first.clean).toBe(false);
        expect(await status(campaignId)).toBe("PARTIAL");
        const outstanding = variantGids.filter((gid) => chaos.fake.priceOf(gid) !== sale(gid)).length;
        expect(outstanding).toBeGreaterThan(BLAST_RADIUS_THRESHOLD);

        // Resume, as the button posts it: handed on to finish, not refused.
        const resumed = await resume(campaignId);
        expect(resumed.message, "Resume asked for a confirmation box the page does not have").not.toMatch(
          /confirmation box/,
        );
        expect(resumed.ok).toBe(true);
        expect(enqueued).toEqual([{ name: "execution", ref: expect.objectContaining({ campaignId, resume: true }) }]);

        const { handleJob } = await import("../../app/worker/handlers.server");
        await handleJob(enqueued[0].name, enqueued[0].ref);
        expect(await status(campaignId)).toBe("ACTIVE");
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
      },
    );
  });
});
