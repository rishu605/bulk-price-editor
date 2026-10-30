/**
 * The campaign page reads a stored plan instead of planning on every load (#812).
 *
 * The page planned its whole campaign on every load and every tab switch, the Apply press
 * planned it again before the run planned it a third time, and the Revert dialog planned it
 * once more as it opened. At 102,132 variants one plan took 2 min 20 s on an idle server and
 * pushed every shop's `/healthz` to 3-5 s (#803). Now each campaign's preview, rollback report
 * and keepers are stored, judged current against the database's own log of writes, and read.
 *
 * What this holds the change to:
 *
 *   - once a plan is stored, opening the page, every tab, the Apply press and the Revert
 *     dialog make no plan -- counted where a plan's cost is, at `previewCampaign`,
 *     `rollbackReport` and the candidate load;
 *   - every write a plan reads makes the stored plan stale, and a stale one is never shown as
 *     the answer;
 *   - a stored number that under-counts can never be what skipped the typed confirmation:
 *     the run checks its own plan, inline and in the worker, and so does a scheduled start;
 *   - the stored plan agrees with what the run writes and the revert puts back (rule 4).
 *
 * Driven through the page's own loader and action, the Revert dialog's route, the status
 * route the page polls and the worker's own handler. Replaced: `authenticate.admin`, the
 * shop's session, `notify`, the web queue (a recorder, or none) and the two inline budgets.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { SCHEDULER_ACTOR } from "../../app/lib/audit/actor";
import { queuedRefusal } from "../../app/lib/campaigns/queued-refusal";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { STALE_PREVIEW_REFUSAL, UNPLANNED_REFUSAL } from "../../app/services/campaigns/blast-radius.server";
import {
  planSummaryState,
  prunePlanInputChanges,
  refreshPlanSummary,
} from "../../app/services/campaigns/plan-summary.server";
import type { loader as pageLoader } from "../../app/routes/app.campaigns.$id";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };
let queue = true;
let inlinePlanVariants = 500;
let inlineBudgetMs: number | null = null;
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

/** Every full plan, where its cost is. */
const plans = { previews: 0, reports: 0, loads: 0 };
const anyPlan = () => plans.previews + plans.reports + plans.loads;
const forget = () => Object.assign(plans, { previews: 0, reports: 0, loads: 0 });

vi.mock("../../app/services/campaigns/preview.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/preview.server")>();
  return {
    ...actual,
    previewCampaign: async (...args: Parameters<typeof actual.previewCampaign>) => {
      plans.previews++;
      return actual.previewCampaign(...args);
    },
  };
});

vi.mock("../../app/services/campaigns/rollback-report.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/rollback-report.server")>();
  return {
    ...actual,
    rollbackReport: async (...args: Parameters<typeof actual.rollbackReport>) => {
      plans.reports++;
      return actual.rollbackReport(...args);
    },
  };
});

vi.mock("../../app/services/campaigns/candidates.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/candidates.server")>();
  return {
    ...actual,
    loadCandidates: async (...args: Parameters<typeof actual.loadCandidates>) => {
      plans.loads++;
      return actual.loadCandidates(...args);
    },
  };
});

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

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, pending.endpoint) };
});

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
}));

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () =>
    queue
      ? {
          async enqueue(name: QueueName, ref: JobRef) {
            enqueued.push({ name, ref });
          },
          async depths() {
            return {};
          },
          async close() {},
        }
      : null,
}));

vi.mock("../../app/lib/execution/inline-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/execution/inline-budget")>();
  return {
    ...actual,
    get PAGE_INLINE_PLAN_VARIANTS() {
      return inlinePlanVariants;
    },
    get PAGE_INLINE_BUDGET_MS() {
      return inlineBudgetMs ?? actual.PAGE_INLINE_BUDGET_MS;
    },
  };
});

beforeEach(() => {
  forget();
  enqueued.length = 0;
  queue = true;
  inlinePlanVariants = 500;
  inlineBudgetMs = null;
});

type Page = Awaited<ReturnType<typeof pageLoader>>;
type Answer = { ok: boolean; message: string };

function use(chaos: ChaosContext) {
  pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
}

/** The campaign page's loader, on a tab. */
async function page(campaignId: string, tab?: string): Promise<Page> {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const query = tab ? `?tab=${tab}` : "";
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}${query}`),
    params: { id: campaignId },
    context: {},
  } as never)) as Page;
}

/** A press on the campaign page, as its buttons post it. */
async function press(campaignId: string, intent: string, confirmation?: string): Promise<Answer> {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  if (confirmation !== undefined) body.set("confirmation", confirmation);
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as Answer;
}

/** The Revert dialog's ask, as `useKeepers` posts it. */
async function keepers(campaignId: string) {
  const { action } = await import("../../app/routes/app.revert-preview");
  const body = new FormData();
  body.set("campaignId", campaignId);
  return action({
    request: new Request("https://example.invalid/app/revert-preview", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
}

/** What the page polls while a plan is worked out. */
async function polled(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaign-status");
  return loader({
    request: new Request(`https://example.invalid/app/campaign-status?id=${campaignId}`),
    params: {},
    context: {},
  } as never);
}

/** The worker, running each planning job the page asked for. */
async function work() {
  const { handleJob } = await import("../../app/worker/handlers.server");
  for (const job of enqueued.splice(0).filter((job) => job.name === "planning")) await handleJob(job.name, job.ref);
}

/**
 * Makes the stored plan read as current while keeping its numbers: a stored number that is
 * wrong and looks right -- the case nothing about staleness can catch, and the one the run's
 * own check exists for.
 */
async function forgeCurrent(campaignId: string) {
  await prisma.$executeRaw`
    UPDATE "plan_summaries"
    SET "snapshot" = pg_current_snapshot()::text,
        "snapshotXmin" = (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint,
        "computedAt" = (${new Date()}::timestamptz AT TIME ZONE 'UTC')
    WHERE "campaignId" = ${campaignId}`;
}

const status = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
const runsOf = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId } });
const TABS = [undefined, "overview", "preview", "runs", "revert", "ledger"];

/** The preview as the page renders it, without the moment it was stored. */
const numbers = (preview: Page["preview"]) => ({ ...preview, asOf: undefined });

describe("chaos: the campaign page reads a stored plan (#812)", () => {
  it("opens the page, every tab, the Apply press and the Revert dialog with no plan once one is stored", async () => {
    await withChaos("plan-summary-counted", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -95 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      use(chaos);
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);

      // The control: nothing is stored yet, and a small scope is planned as the page loads.
      const first = await page(campaignId);
      expect(plans.previews, "the first load of a small campaign made no plan").toBe(1);
      expect(first.preview.blastRadius).toBe(true);
      expect(first.preview.recomputing).toBeUndefined();
      expect(await planSummaryState(shopId, campaignId)).toBe("current");
      expect(enqueued, "a small scope was handed to the worker").toEqual([]);

      forget();
      for (const tab of TABS) {
        const shown = await page(campaignId, tab);
        expect(anyPlan(), `opening the ${tab ?? "default"} tab planned the campaign`).toBe(0);
        expect(numbers(shown.preview)).toEqual(numbers(first.preview));
      }
      expect((await keepers(campaignId)).keepers, "a draft has nothing to revert").toEqual([]);
      expect(anyPlan(), "the Revert dialog planned the campaign").toBe(0);

      // Apply without the word: refused from the stored preview, in the dialog's sentences.
      const refused = await press(campaignId, "apply");
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("8 prices move more than 50% from their baseline");
      expect(anyPlan(), "the Apply press planned the campaign to refuse it").toBe(0);
      expect(variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid))).toBe(true);
      expect(await runsOf(campaignId)).toBe(0);

      // With it: one plan, the run's own, which decides what is written.
      const applied = await press(campaignId, "apply", "apply");
      expect(applied.ok, applied.message).toBe(true);
      expect(plans.previews, "the Apply press previewed the campaign before its run").toBe(0);
      expect(plans.loads, "anything but the run's own plan").toBe(1);
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));

      // The run wrote what the plan reads, so the stored plan is stale; small, so planned as
      // the page loads -- with the rollback report and the keepers -- and then read.
      expect(await planSummaryState(shopId, campaignId)).toBe("stale");
      forget();
      const active = await page(campaignId);
      expect(plans.reports, "the rollback report was not worked out with the plan").toBe(1);
      expect(active.rollback?.counts.total).toBe(8);
      forget();
      for (const tab of TABS) {
        const shown = await page(campaignId, tab);
        expect(anyPlan(), `opening the ${tab ?? "default"} tab of an active campaign planned it`).toBe(0);
        expect(shown.rollback).toEqual(active.rollback);
      }
      expect(await keepers(campaignId)).toEqual({ repriced: 8, keepers: [] });
      expect(anyPlan(), "the Revert dialog of an active campaign planned it").toBe(0);
    });
  });

  it("hands a large scope's plan to the worker, never shows a stale one as current, and reads the worker's", async () => {
    await withChaos("plan-summary-worker", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      use(chaos);
      inlinePlanVariants = 2;

      // Nothing stored and too large to plan here: said, with no Apply, and asked of the worker once.
      const waiting = await page(campaignId);
      expect(waiting.preview.planning).toMatch(/^Working out what this campaign would do\. It covers 8 variants/);
      expect(waiting.preview.counts.planned).toBe(0);
      expect(anyPlan(), "the page planned a scope over its threshold").toBe(0);
      expect(enqueued).toEqual([{ name: "planning", ref: { shopId, campaignId } }]);
      await page(campaignId);
      expect(enqueued, "a second load asked for a second plan").toHaveLength(1);
      expect((await polled(campaignId)).plan).toEqual({ at: null, waiting: true });

      // Apply with nothing to have shown anyone asks for the word, and plans nothing.
      expect((await press(campaignId, "apply")).message).toBe(UNPLANNED_REFUSAL);
      expect(anyPlan()).toBe(0);
      expect(enqueued.filter((job) => job.name === "execution")).toEqual([]);

      // The worker plans it; the page reads it.
      await work();
      expect(plans.previews, "the worker made no plan").toBe(1);
      forget();
      const ready = await page(campaignId);
      expect(anyPlan(), "the page planned over a current stored plan").toBe(0);
      expect(ready.preview.planning).toBeUndefined();
      expect(ready.preview.recomputing).toBeUndefined();
      expect(ready.preview.counts.planned).toBe(8);
      expect((await polled(campaignId)).plan).toEqual({ at: ready.preview.asOf, waiting: false });

      // A baseline recaptured at a new price: the stored plan is stale, shown as the last
      // numbers with the sentence, and worked out again -- asked once.
      const moved = variantGids[0];
      await prisma.$transaction([
        prisma.baseline.updateMany({ where: { shopId, variantGid: moved, supersededAt: null }, data: { supersededAt: new Date() } }),
        prisma.baseline.create({
          data: { shopId, variantGid: moved, surfaceKind: "BASE", priceListGid: "", currency: "USD", basePrice: 50_000n, source: "RECAPTURE" },
        }),
      ]);
      const stale = await page(campaignId);
      expect(stale.preview.recomputing, "a stale plan was shown as the answer").toMatch(/^These numbers were worked out at /);
      expect(stale.preview.asOf).toBe(ready.preview.asOf);
      expect(numbers({ ...stale.preview, recomputing: undefined })).toEqual(numbers(ready.preview));
      expect(anyPlan()).toBe(0);
      expect(enqueued).toEqual([{ name: "planning", ref: { shopId, campaignId } }]);
      await page(campaignId, "preview");
      expect(enqueued, "every load of a stale plan asked again").toHaveLength(1);

      // Apply over it asks for the word, whatever its numbers say.
      expect((await press(campaignId, "apply")).message).toBe(STALE_PREVIEW_REFUSAL);
      expect(anyPlan()).toBe(0);

      await work();
      const fresh = await page(campaignId);
      expect(fresh.preview.recomputing).toBeUndefined();
      expect(fresh.preview.rows.find((row) => row.variantGid === moved)?.after).toBe("450.00");
    });
  });

  it("marks a stored plan stale on every write a plan reads, and on nothing else", async () => {
    await withChaos("plan-summary-stale", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      use(chaos);
      const other = await createCampaign(shopId, {
        name: "chaos/other",
        priority: 50,
        rule: { kind: "percent-change", percent: -30 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      } as never);
      const segment = await prisma.segment.create({ data: { shopId, name: "chaos/segment", filterAst: { groups: [] } } });
      const run = await prisma.campaignRun.create({ data: { shopId, campaignId: other.id, kind: "APPLY", occurrenceKey: "chaos-812", status: "COMPLETED" } });
      const file = await prisma.priceImport.create({ data: { shopId, name: "chaos/file", currency: "USD" } });
      await prisma.priceListRecord.create({ data: { shopId, priceListGid: "gid://shopify/PriceList/812", name: "Canada", currency: "CAD" } });
      const [first, second] = variantGids;

      const writes: Array<[string, () => Promise<unknown>]> = [
        ["the campaign's own rule", () => prisma.campaign.update({ where: { id: campaignId }, data: { ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -40 } }] } })],
        ["the variants it let go of", () => prisma.campaign.update({ where: { id: campaignId }, data: { excludedVariantGids: [first] } })],
        ["its priority", () => prisma.campaign.update({ where: { id: campaignId }, data: { priority: 901 } })],
        ["its surfaces", () => prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [] } } })],
        ["another campaign's status", () => prisma.campaign.update({ where: { id: other.id }, data: { status: "ACTIVE" } })],
        ["another campaign's priority", () => prisma.campaign.update({ where: { id: other.id }, data: { priority: 2_000 } })],
        ["a segment's definition", () => prisma.segment.update({ where: { id: segment.id }, data: { filterAst: { groups: [{ conditions: [{ field: "tag", value: "x" }] }] } } })],
        ["a campaign's segments", () => prisma.campaign.update({ where: { id: other.id }, data: { segments: { connect: { id: segment.id } } } })],
        ["a baseline captured", () => prisma.baseline.create({ data: { shopId, variantGid: second, surfaceKind: "MARKET", priceListGid: "gid://shopify/PriceList/812", currency: "CAD", basePrice: 1_000n, source: "AUTO_ENROLL" } })],
        ["a baseline superseded", () => prisma.baseline.updateMany({ where: { shopId, variantGid: second, surfaceKind: "MARKET" }, data: { supersededAt: new Date() } })],
        ["the catalogue mirror, by a sync or the products webhook", () => prisma.variantIndex.update({ where: { shopId_variantGid: { shopId, variantGid: second } }, data: { tags: ["chaos", "new"] } })],
        ["a variant deleted in Shopify", () => prisma.variantIndex.update({ where: { shopId_variantGid: { shopId, variantGid: second } }, data: { deletedAt: new Date() } })],
        ["a live price", () => prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: first }, data: { livePrice: 1_234n } })],
        ["the store's guardrails", () => prisma.shop.update({ where: { id: shopId }, data: { settings: { minPrice: 1 } } })],
        ["a market", () => prisma.priceListRecord.update({ where: { shopId_priceListGid: { shopId, priceListGid: "gid://shopify/PriceList/812" } }, data: { adjustmentBps: -1_000 } })],
        ["a market gone", () => prisma.priceListRecord.deleteMany({ where: { shopId, priceListGid: "gid://shopify/PriceList/812" } })],
        ["held drift", () => prisma.driftEvent.create({ data: { shopId, variantGid: first, surfaceKind: "BASE", priceListGid: "", campaignId: other.id, observedPrice: 1n, expectedPrice: 2n, currency: "USD", resolution: "PENDING" } })],
        ["a run", () => prisma.campaignRun.update({ where: { id: run.id }, data: { status: "PARTIAL" } })],
        ["the ledger", () => prisma.variantChange.create({ data: { runId: run.id, shopId, variantGid: first, surfaceKind: "BASE", currency: "USD", intendedPrice: 900n, status: "VERIFIED" } })],
        ["a market-wide change", () => prisma.priceListChange.create({ data: { shopId, runId: run.id, campaignId: other.id, priceListGid: "gid://shopify/PriceList/812", appliedAdjustmentBps: -500 } })],
        ["an imported file's prices", () => prisma.priceImportRow.create({ data: { importId: file.id, variantGid: first, price: 700n } })],
        ["another campaign gone", () => prisma.campaign.delete({ where: { id: other.id } })],
      ];

      for (const [what, write] of writes) {
        await refreshPlanSummary(shopId, campaignId);
        expect(await planSummaryState(shopId, campaignId), `planned, and not current, before ${what}`).toBe("current");
        await write();
        expect(await planSummaryState(shopId, campaignId), `${what} left the stored plan current`).toBe("stale");

        // And never shown as the answer: the page, over its threshold, says it is being redone.
        inlinePlanVariants = 2;
        const shown = await page(campaignId);
        expect(shown.preview.recomputing, `after ${what} the page showed the stored plan as current`).toBeTruthy();
        inlinePlanVariants = 500;
        enqueued.length = 0;
      }

      // Bookkeeping no plan reads leaves it current: a sync's progress on the shop row, a
      // run's heartbeat, and the stored plan's own row.
      const live = await prisma.campaignRun.create({ data: { shopId, campaignId, kind: "ENROLL", occurrenceKey: "chaos-812-live", status: "COMPLETED" } });
      const unread: Array<[string, () => Promise<unknown>]> = [
        ["a sync's progress", () => prisma.shop.update({ where: { id: shopId }, data: { syncHeartbeatAt: new Date(), syncPhase: "variants", syncProgress: { done: 1 } } })],
        ["a run's heartbeat", () => prisma.campaignRun.update({ where: { id: live.id }, data: { heartbeatAt: new Date() } })],
        ["the plan's own row", () => prisma.planSummary.update({ where: { campaignId }, data: { requestedAt: new Date() } })],
        ["nothing at all", async () => undefined],
      ];
      for (const [what, write] of unread) {
        await refreshPlanSummary(shopId, campaignId);
        await write();
        expect(await planSummaryState(shopId, campaignId), `${what} made the stored plan stale`).toBe("current");
      }

      // A write that began before the plan and committed after it: invisible to the plan, so
      // stale, though its timestamp is older than the plan's -- what a watermark would miss.
      await prisma.$transaction(async (tx) => {
        await tx.variantIndex.update({ where: { shopId_variantGid: { shopId, variantGid: first } }, data: { title: "renamed" } });
        await refreshPlanSummary(shopId, campaignId);
      });
      expect(await planSummaryState(shopId, campaignId), "a write committed during the plan left it current").toBe("stale");

      // And past its age, whatever the log says: Shopify's market settings are read live.
      await refreshPlanSummary(shopId, campaignId);
      await prisma.planSummary.update({ where: { campaignId }, data: { computedAt: new Date(Date.now() - 7 * 60 * 60_000) } });
      expect(await planSummaryState(shopId, campaignId), "a six-hour-old plan read as current").toBe("stale");
    });
  });

  it("never lets a stored number that under-counts skip the typed confirmation, here, in the worker or at a scheduled start", async () => {
    await withChaos("plan-summary-undercount", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      use(chaos);
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
      const untouched = () => variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid));

      // 10% off eight prices asks for nothing. Then the rule becomes 95% off, and the stored
      // plan is made to read as current with the old numbers.
      expect((await page(campaignId)).preview.blastRadius).toBe(false);
      await prisma.campaign.update({ where: { id: campaignId }, data: { ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -95 } }] } });
      await forgeCurrent(campaignId);
      forget();
      const shown = await page(campaignId);
      expect(anyPlan()).toBe(0);
      expect(shown.preview.blastRadius, "the forged plan did not under-count").toBe(false);

      // In the request: the press is let through on the stored number, and the run refuses it on its own plan.
      const inline = await press(campaignId, "apply");
      expect(inline.ok, "a stale under-count skipped the typed confirmation").toBe(false);
      expect(inline.message).toContain("8 prices move more than 50% from their baseline");
      expect(inline.message).toContain("The preview this was pressed over said less");
      expect(inline.message).toContain("Type “apply” in the confirmation box");
      expect(inline.message, "the refusal carries a price").not.toContain("$");
      expect(untouched(), "a refused press wrote a price").toBe(true);
      expect(await status(campaignId)).toBe("DRAFT");
      expect(await runsOf(campaignId), "the refusal came after a run row").toBe(0);

      // In the worker: the press is queued with the flag, and the worker's run refuses it.
      inlineBudgetMs = 0;
      await forgeCurrent(campaignId);
      const queued = await press(campaignId, "apply");
      expect(queued.ok, queued.message).toBe(true);
      const job = enqueued.find((entry) => entry.name === "execution");
      expect(job?.ref.untypedPress, "the worker was not told the word was not typed").toBe(true);
      const { handleJob } = await import("../../app/worker/handlers.server");
      await expect(handleJob(job!.name, job!.ref)).rejects.toThrow(/said less/);
      expect(untouched(), "the worker wrote over a stale under-count").toBe(true);
      expect(await status(campaignId)).toBe("DRAFT");
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(queuedRefusal(campaign.schedule)?.reason, "the worker's refusal is not on the campaign").toContain("8 prices move more than 50%");

      // A scheduled start reads the run's own plan too, never the stored one (#1009).
      await forgeCurrent(campaignId);
      await expect(chaos.apply({ actor: SCHEDULER_ACTOR, claimedFrom: "DRAFT" })).rejects.toThrow(/cannot ask anyone to type/);
      expect(untouched()).toBe(true);

      // With the word typed, it applies.
      inlineBudgetMs = null;
      const typed = await press(campaignId, "apply", "apply");
      expect(typed.ok, typed.message).toBe(true);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.05) / 100).toFixed(2));
    });
  });

  it("stores the plan the run writes and the revert puts back (rule 4)", async () => {
    await withChaos("plan-summary-agrees", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      use(chaos);
      inlinePlanVariants = 2;
      const lower = await createCampaign(shopId, {
        name: "chaos/lower",
        priority: 50,
        rule: { kind: "percent-change", percent: -30 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      } as never);
      await prisma.campaign.update({ where: { id: lower.id }, data: { status: "ACTIVE" } });

      await page(campaignId);
      await work();
      const stored = (await page(campaignId)).preview;
      expect(stored.recomputing).toBeUndefined();

      // What is stored is what `previewCampaign` says, exactly: data, not a second calculation.
      const { previewCampaign } = await import("../../app/services/campaigns/preview.server");
      const now = await previewCampaign(shopId, campaignId, { client: chaosAdminClient(chaos.server.endpoint()) });
      expect(numbers(stored)).toEqual(JSON.parse(JSON.stringify(now)));
      expect(stored.overlaps).toEqual([expect.objectContaining({ campaignId: lower.id })]);

      // Applied without the word, which the stored plan did not ask for: it writes the stored rows.
      const applied = await press(campaignId, "apply");
      expect(applied.ok, applied.message).toBe(true);
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      expect(run.plannedRows).toBe(stored.counts.planned);
      for (const row of stored.rows) expect(row.after, `${row.variantGid} written at another price`).toBe(chaos.fake.priceOf(row.variantGid));
      await chaos.expectHonest(run.id);

      // The Revert dialog and the rollback report, stored by the worker, say what the revert does.
      await page(campaignId);
      await work();
      forget();
      const active = await page(campaignId, "revert");
      const kept = await keepers(campaignId);
      expect(anyPlan()).toBe(0);
      expect(kept.recomputing).toBeUndefined();
      expect(kept.keepers).toEqual([{ campaignId: lower.id, name: "chaos/lower", variants: variantGids.length }]);
      // The page carries the rows its tab renders; the export carries every one, from the server.
      const { loader: exporter } = await import("../../app/routes/app.export.$kind");
      const file = (await exporter({
        request: new Request(`https://example.invalid/app/export/rollback?campaign=${campaignId}`),
        params: { kind: "rollback" },
        context: {},
      } as never)) as Response;
      expect(file.status).toBe(200);
      expect((await file.text()).trim().split("\n")).toHaveLength(variantGids.length + 1);
      expect(anyPlan(), "the export worked out a current stored report again").toBe(0);

      const reverted = await press(campaignId, "revert");
      expect(reverted.ok, reverted.message).toBe(true);
      for (const row of active.rollback!.rows) {
        expect(row.revertsTo, `${row.variantGid} reverted to another price`).toBe(chaos.fake.priceOf(row.variantGid));
        expect(chaos.fake.priceOf(row.variantGid)).toBe((Math.round(baseline.get(row.variantGid)! * 0.7) / 100).toFixed(2));
      }
    });
  });

  it("plans in the page when there is no worker queue, and stores it for the next load", async () => {
    await withChaos("plan-summary-no-queue", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { campaignId } = chaos.fixture;
      use(chaos);
      inlinePlanVariants = 2;
      queue = false;

      const first = await page(campaignId);
      expect(first.preview.planning, "with no worker, a large scope was left unplanned").toBeUndefined();
      expect(plans.previews).toBe(1);
      forget();
      await page(campaignId, "preview");
      expect(anyPlan(), "the plan made with no worker was not stored").toBe(0);
    });
  });

  it("prunes the log only past the age any stored plan could still be current about", async () => {
    const shopId = "chaos-812-prune";
    const now = new Date();
    await prisma.planInputChange.createMany({
      data: [
        { shopId, xid: 1n, at: new Date(now.getTime() - 3 * 24 * 60 * 60_000) },
        { shopId, xid: 2n, at: new Date(now.getTime() - 60_000) },
      ],
    });
    await prunePlanInputChanges(now);
    const kept = await prisma.planInputChange.findMany({ where: { shopId }, select: { xid: true } });
    expect(kept).toEqual([{ xid: 2n }]);
    await prisma.planInputChange.deleteMany({ where: { shopId } });
  });
});
