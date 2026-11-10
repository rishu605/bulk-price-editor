/**
 * Rules from cost and off the compare-at, and the compare-at policy, through the real paths
 * (#817, PRD A-3.1 and A-3.3, D32).
 *
 * The engine priced cost-plus and "x% off the compare-at", and could skip or stop over a
 * strike-through not above the price, and none of it could be chosen. Here each is made as the
 * editor posts it, previewed by the editor's preview and the campaign's, and applied:
 *
 * - cost times 2 prices from cost, and leaves the variant with no cost at its price, saying so
 *   on its row, beside the counts and in the run's answer;
 * - 25% off the compare-at prices from the baseline's compare-at, and leaves the one without;
 * - a 10% rise with the compare-at set to the baseline, under "Stop the campaign", is refused
 *   in both previews and at Apply, with nothing written; under the default it drops the
 *   strike-through, as every campaign did before the choice existed.
 *
 * Replaced: `authenticate`, `adminClientForShop` and `toAdminClient`, `notify`, and the web
 * queue, as in `campaign-guardrails`.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AppError } from "../../app/lib/errors/app-error";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import type { DraftPreview } from "../../app/services/campaigns/draft-preview.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";
import { judge } from "../harness/verdict";

let shop = "";
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop }, sessionToken: { sub: "91614707946" }, admin: chaosAdminContext(endpoint) }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
}));

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  // Nothing here is large enough to plan in the background, so nothing is enqueued.
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      void name;
      void ref;
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

/** Three products, one variant each. */
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/**
 * Every baseline at $100, and each variant's cost and compare-at as given, in fixture order:
 * on the baseline, which is what a campaign prices from.
 */
async function useShop(chaos: ChaosContext, per: Array<{ cost?: bigint; compareAt?: bigint }>) {
  endpoint = chaos.server.endpoint();
  shop = chaos.fixture.domain;
  const { shopId, variantGids } = chaos.fixture;
  await Promise.all(
    variantGids.map((variantGid, index) =>
      prisma.baseline.updateMany({
        where: { shopId, variantGid, supersededAt: null },
        data: { basePrice: 10_000n, cost: per[index]?.cost ?? null, baseCompareAt: per[index]?.compareAt ?? null },
      }),
    ),
  );
}

/** The editor's live preview, as its form posts to it. */
async function draftPreview(fields: Record<string, string>): Promise<DraftPreview> {
  const { action } = await import("../../app/routes/app.preview-draft");
  return (await action({
    request: new Request("https://example.invalid/app/preview-draft", { method: "POST", body: formOf(fields) }),
    params: {},
    context: {},
  } as never)) as DraftPreview;
}

/** The editor's Create, as its form posts it, over the fixture's products. */
async function create(name: string, fields: Record<string, string>): Promise<string> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const answer = await action({
    request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body: formOf({ name, tag: "chaos", ...fields }) }),
    params: {},
    context: {},
  } as never);
  expect(answer, `${name} was not created`).toBeInstanceOf(Response);
  return (answer as Response).headers.get("Location")!.split("/").pop()!;
}

const apply = (chaos: ChaosContext, campaignId: string) =>
  runCampaign(chaos.fixture.shopId, campaignId, chaosAdminClient(endpoint), { actor: "chaos", verifySampleRate: 1 });

describe("chaos: rules from cost and off the compare-at (#817)", () => {
  it("prices from cost, and leaves a variant with no cost at its price, saying why", async () => {
    await withChaos("rule-from-cost", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      // $30 and $45 costs; the third has none.
      await useShop(chaos, [{ cost: 3_000n }, { cost: 4_500n }, {}]);
      const fields = { ruleKind: "from-cost-multiplier", ruleValue: "2", compareAt: "leave" };

      const draft = await draftPreview({ ...fields, tag: "chaos" });
      expect(draft).toMatchObject({ matched: 3, changing: 2, skipped: 1, ruleNeeds: { cost: 1, compareAt: 0 } });
      expect(draft.rows.find((row) => row.variantGid === variantGids[2])?.skippedReason).toBe("Needs a cost: none recorded");

      const campaignId = await create("Cost times two", fields);
      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      expect(preview.counts).toMatchObject({ planned: 2, skipped: 1 });
      expect(preview.rows.find((row) => row.variantGid === variantGids[2])).toMatchObject({ status: "skipped", reason: "needs-cost" });

      const before = chaos.fake.priceOf(variantGids[2]);
      const run = await apply(chaos, campaignId);
      expect(run.clean).toBe(true);
      expect(run.verified).toBe(2);
      expect(run.messages).toContain("1 product was skipped: they have no cost recorded, and this rule prices from cost.");
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(["60.00", "90.00", before]);
      expect(chaos.fake.writeLog.map((write) => write.variantGid)).not.toContain(variantGids[2]);
      const verdict = await judge({ ...chaos.fixture, campaignId }, chaos.fake, run.runId);
      expect(verdict.violations).toEqual([]);
    });
  });

  it("prices a percentage off the baseline's compare-at, and leaves a variant without one", async () => {
    await withChaos("rule-off-compare-at", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      // Compare-ats of $120 and $160 on a $100 baseline; the third has none.
      await useShop(chaos, [{ compareAt: 12_000n }, { compareAt: 16_000n }, {}]);
      const fields = { ruleKind: "percent-of-compare-at", ruleValue: "25", compareAt: "leave" };

      const draft = await draftPreview({ ...fields, tag: "chaos" });
      expect(draft).toMatchObject({ changing: 2, skipped: 1, ruleNeeds: { cost: 0, compareAt: 1 } });
      expect(draft.rows.find((row) => row.variantGid === variantGids[2])?.skippedReason).toBe("Needs a compare-at: none in its baseline");

      const campaignId = await create("A quarter off the compare-at", fields);
      expect((await previewCampaign(shopId, campaignId, { limit: 100 })).rows.find((row) => row.variantGid === variantGids[2])?.reason).toBe(
        "needs-compare-at",
      );
      const before = chaos.fake.priceOf(variantGids[2]);
      const run = await apply(chaos, campaignId);
      expect(run.verified).toBe(2);
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(["90.00", "120.00", before]);
    });
  });
});

describe("chaos: a campaign's compare-at policy (#817, PRD A-3.3)", () => {
  // A 10% rise over a $100 baseline, with the strike-through set to the baseline: $110 over a
  // $100 compare-at, which shows no saving on every variant.
  const RISE = { ruleKind: "percent-change", ruleValue: "10", ruleDirection: "up", compareAt: "set-to-baseline" };

  it("stops the campaign when it chose to, in both previews and at Apply, with nothing written", async () => {
    await withChaos("compare-at-block", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await useShop(chaos, []);

      const draft = await draftPreview({ ...RISE, compareAtViolation: "block", tag: "chaos" });
      expect(draft.blocked?.reason).toBe("invalid-compare-at");
      expect(draft.blocked?.message).toMatch(/^This campaign stops when a compare-at would not be above the new price/);

      const campaignId = await create("Stops over its strike-through", { ...RISE, compareAtViolation: "block" });
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).compareAtViolationPolicy).toBe("block");
      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      expect(preview.blocked?.message).toContain('Choose "Drop the strike-through" or "Leave the variant at its price"');

      const refused = await apply(chaos, campaignId).then(
        () => null,
        (error: unknown) => error as AppError,
      );
      expect(refused?.code, "the compare-at policy did not stop the run").toBe("GUARDRAIL_BLOCKED");
      expect(refused?.userMessage).toMatch(/^The compare-at check stopped this run before anything was written/);
      expect(chaos.fake.writeLog, "a blocked run wrote").toHaveLength(0);
    });
  });

  it("leaves the variants at their price under skip, and drops the strike-through by default, as before", async () => {
    await withChaos("compare-at-skip-clear", CATALOG, async (chaos) => {
      const { variantGids } = chaos.fixture;
      await useShop(chaos, []);

      const skipping = await create("Skips over its strike-through", { ...RISE, compareAtViolation: "skip" });
      const skipped = await apply(chaos, skipping);
      expect(skipped.verified).toBe(0);
      expect(skipped.messages).toContain("3 products were skipped: they would have had a compare-at price below their price.");
      expect(chaos.fake.writeLog).toHaveLength(0);

      // No choice posted, as every form before the field: "clear", priced without a strike-through.
      const clearing = await create("Drops its strike-through", RISE);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: clearing } })).compareAtViolationPolicy).toBe("clear");
      const cleared = await apply(chaos, clearing);
      expect(cleared.verified).toBe(3);
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(["110.00", "110.00", "110.00"]);
      expect(variantGids.map((gid) => chaos.fake.variants.get(gid)?.compareAtPrice ?? null)).toEqual([null, null, null]);
    });
  });
});
