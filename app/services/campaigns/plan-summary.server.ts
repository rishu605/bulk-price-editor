/**
 * A campaign's plan, stored and read rather than worked out on every load (#812).
 *
 * The campaign page planned its whole campaign on every load and every tab switch; Apply
 * planned it again before the run planned it a third time; the Revert dialog planned it with
 * the campaign left out; the rollback report planned it twice more. At 102,132 variants one
 * plan took 2 min 20 s on an idle server and pushed every shop's `/healthz` to 3-5 s (#803).
 *
 * Now the answers -- `previewCampaign`'s preview, `rollbackReport`'s report and the Revert
 * dialog's keepers, each exactly as that function returns it -- are stored per campaign in
 * `plan_summaries`, and the page, its dialogs and the Apply press read them. They are data,
 * not a second calculation: the same functions, through the same planner the run uses (rule
 * 4), with the result kept. The run still plans when it starts, and that plan alone decides
 * what is written.
 *
 * ## Current, or not
 *
 * A stored answer is worth reading only if a stale one can never pass for current. The
 * database tells them apart (see the migration): every statement that writes a table a plan
 * reads logs its shop and transaction, and a summary keeps the snapshot it was planned from,
 * taken before the plan read anything. A summary is current while no logged write of its
 * shop is invisible to that snapshot, and for at most `PLAN_SUMMARY_MAX_AGE_MS`. Nobody has
 * to remember to mark anything: a write the planner can see is a write the log has.
 *
 * ## When there is no current one
 *
 * A small scope -- `PAGE_INLINE_PLAN_VARIANTS` -- is planned while the page loads, and the
 * answer stored: current the moment it is shown, and free on the next load. So is any scope
 * when there is no worker queue, as every plan was before (#812 keeps that fallback). A larger
 * one is handed to the worker's `planning` queue, once, and the page shows the last numbers it
 * has with a sentence saying they are being worked out again -- or, with none at all, says one
 * is on its way -- and follows the job (`usePlanPolling`) until a newer one is stored.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import {
  PLAN_IN_FLIGHT,
  PLAN_INPUT_RETENTION_MS,
  PLAN_REQUEST_QUIET_MS,
  planningText,
  recomputingText,
  REVERTABLE,
  shouldRequest,
  summaryState,
  type SummaryState,
} from "../../lib/campaigns/plan-summary";
import { PAGE_INLINE_PLAN_VARIANTS } from "../../lib/execution/inline-budget";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";
import type { QueueRuntime } from "../../worker/queue-runtime.server";
import { enqueueWithin, webQueue } from "../../worker/web-queue.server";
import { keepersOf, type KeepersAfterRevert } from "./keepers.server";
import { planlessPreview, previewCampaign, refusedRule, writingText } from "./preview.server";
import { keepRecapturedCount } from "./recaptured.server";
import { rollbackReport, type RollbackReport } from "./rollback-report.server";
import { scopeSize } from "./scope-size.server";
import type { CampaignPreview } from "./types";

/**
 * How long a page waits for Redis to take a planning job. Shorter than a run's ten seconds:
 * nothing is lost if this one is not taken -- the page shows the last numbers it has and asks
 * again once the request goes quiet -- and a page held for ten seconds is the slowness this
 * exists to remove.
 */
export const PLAN_ENQUEUE_TIMEOUT_MS = 2_000;

/** What a stored plan holds, as the page and its dialogs read it. */
export interface StoredPlan {
  preview: CampaignPreview;
  rollback: RollbackReport | null;
  keepers: KeepersAfterRevert | null;
  /** When the plan was made: the moment its numbers describe. */
  asOf: Date;
}

/** The columns that say whether a summary is current, and whether one has been asked for. */
const STATE = { snapshot: true, snapshotXmin: true, computedAt: true, requestedAt: true } as const;

interface StateRow {
  snapshot: string | null;
  snapshotXmin: bigint | null;
  computedAt: Date | null;
  requestedAt: Date | null;
  preview: Prisma.JsonValue | null;
}

// ------------------------------------------------------------------ the snapshot

/**
 * The database as a plan is about to see it: `pg_current_snapshot()`, and its xmin.
 *
 * Taken in its own statement before the plan's first read. Under read committed every later
 * statement sees at least what this one could, so anything the snapshot shows as committed
 * the plan read; anything it does not -- committed later, or still running now -- the plan
 * may have missed, and makes the summary stale the moment it is logged.
 */
async function takeSnapshot(): Promise<{ snapshot: string; xmin: bigint; at: Date }> {
  // The clock before the snapshot, so the time a summary claims is never later than what it saw.
  const at = new Date();
  const [row] = await prisma.$queryRaw<Array<{ snapshot: string; xmin: string }>>`
    SELECT s::text AS "snapshot", (pg_snapshot_xmin(s))::text AS "xmin" FROM pg_current_snapshot() AS s`;
  return { snapshot: row.snapshot, xmin: BigInt(row.xmin), at };
}

/**
 * Whether any write to a table a plan reads, for this shop, is invisible to `snapshot`.
 *
 * Only the log from the snapshot's xmin on can hold one: every transaction older than that
 * had finished when the snapshot was taken. Read through the (shop, xid) index.
 */
async function changedSince(shopId: string, snapshot: string, xmin: bigint): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ changed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "plan_input_changes"
      WHERE "shopId" = ${shopId} AND "xid" >= ${xmin}
        AND NOT pg_visible_in_snapshot(("xid"::text)::xid8, ${snapshot}::pg_snapshot)
    ) AS "changed"`;
  // No answer is not "unchanged".
  return row?.changed !== false;
}

/** Whether this stored row is the answer now. */
async function stateOf(shopId: string, row: StateRow | null, now: Date): Promise<SummaryState> {
  if (!row || row.preview === null || !row.computedAt) return "missing";
  const changed = row.snapshot && row.snapshotXmin !== null ? await changedSince(shopId, row.snapshot, row.snapshotXmin) : true;
  return summaryState(row, changed, now);
}

/** Whether this campaign's stored plan is current, stale or not there: for tests and the status poll. */
export async function planSummaryState(shopId: string, campaignId: string, now = new Date()): Promise<SummaryState> {
  const row = await prisma.planSummary.findFirst({ where: { campaignId, shopId }, select: { ...STATE, preview: true } });
  return stateOf(shopId, row, now);
}

// ------------------------------------------------------------------ planning it

/**
 * Plans the campaign and stores the answers: the worker's planning job, and the page's own
 * plan of a small scope.
 *
 * The preview always; the rollback report and the Revert dialog's keepers for a campaign that
 * has written something and can be reverted, as the page shows them. Each from its own
 * function, unchanged -- this keeps answers, it does not compute them. `client` lets the
 * preview say how each market will be written; without one it says that is decided at run time.
 */
export async function refreshPlanSummary(
  shopId: string,
  campaignId: string,
  client?: AdminClient,
  where: "page" | "worker" = "page",
): Promise<StoredPlan> {
  const started = Date.now();
  const { snapshot, xmin, at } = await takeSnapshot();

  const preview = await previewCampaign(shopId, campaignId, { client });
  const rollback = (await hasRollback(campaignId, preview.status)) ? await rollbackReport(shopId, campaignId) : null;
  // Asked as the Revert dialog opens, which is every page load of a campaign that has one:
  // worked out here, with the rest, so the dialog reads it instead of planning (#812).
  const keepers = rollback && rollback.counts.total > 0 ? await keepersOf(shopId, campaignId) : null;

  const answers = {
    preview: preview as unknown as Prisma.InputJsonValue,
    rollback: rollback ? (rollback as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    keepers: keepers ? (keepers as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    snapshot,
    snapshotXmin: xmin,
    computedAt: at,
  };
  await prisma.planSummary.upsert({
    where: { campaignId },
    create: { campaignId, shopId, ...answers },
    // Not `requestedAt`: a plan asked of the worker after this one began is still owed.
    update: answers,
  });
  // The count the campaigns list, Home and the calendar read (#1166), as this plan found it:
  // begun at its snapshot, so a recapture counted since is not overwritten by it.
  if (preview.recapturedAtSale !== undefined) await keepRecapturedCount(shopId, campaignId, preview.recapturedAtSale, at);

  // Durations and counts, never a price.
  metric("plan.summary_ms", Date.now() - started, {
    shopId,
    campaignId,
    where,
    variants: preview.counts.planned + preview.counts.noop + preview.counts.skipped,
    rollbackRows: rollback?.counts.total ?? 0,
  });

  return { preview: { ...preview, asOf: at.toISOString() }, rollback, keepers, asOf: at };
}

/** Whether the page shows this campaign a rollback report: it can be reverted, and has applied. */
async function hasRollback(campaignId: string, status: string): Promise<boolean> {
  if (!REVERTABLE.has(status)) return false;
  return (await prisma.campaignRun.findFirst({ where: { campaignId, kind: "APPLY" }, select: { id: true } })) !== null;
}

/**
 * Where a plan of this campaign may be made: here, for a scope small enough to plan while a
 * page waits or when there is no worker queue, or by the worker. Counted, not read from a
 * stored summary, whose own count may be the stale thing (see `PAGE_INLINE_PLAN_VARIANTS`).
 *
 * The larger of the scope and the last apply's rows, for a campaign that has written: a
 * revert and its report plan over what the campaign wrote, not only over what its scope says
 * now, and a scope emptied after a 102,132-variant sale would otherwise count as nothing.
 */
async function whereToPlan(shopId: string, campaignId: string, status: string): Promise<{ queue: QueueRuntime | null; variants: number }> {
  const scope = await scopeSize(shopId, campaignId);
  const written = REVERTABLE.has(status)
    ? ((
        await prisma.campaignRun.findFirst({
          where: { campaignId, kind: "APPLY" },
          orderBy: { createdAt: "desc" },
          select: { plannedRows: true },
        })
      )?.plannedRows ?? 0)
    : 0;
  const variants = Math.max(scope, written);
  // Redis is not touched for a small scope at all.
  return { queue: variants > PAGE_INLINE_PLAN_VARIANTS ? webQueue() : null, variants };
}

/**
 * Asks the worker for a plan of this campaign, unless one is already on its way: claimed on
 * the row in one statement, so two pages loading at once ask once between them. The same
 * three conditions as `shouldRequest`, which the status poll reads: nothing asked, the last
 * ask answered by a plan begun after it, or the last ask gone quiet.
 */
async function requestPlan(shopId: string, campaignId: string, queue: QueueRuntime, now = new Date()): Promise<boolean> {
  const answered = await prisma.$executeRaw`
    INSERT INTO "plan_summaries" ("campaignId", "shopId", "requestedAt")
    VALUES (${campaignId}, ${shopId}, (${now}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("campaignId") DO UPDATE SET "requestedAt" = EXCLUDED."requestedAt"
    WHERE "plan_summaries"."requestedAt" IS NULL
       OR "plan_summaries"."requestedAt" <= COALESCE("plan_summaries"."computedAt", '-infinity'::timestamp)
       OR "plan_summaries"."requestedAt" < (${new Date(now.getTime() - PLAN_REQUEST_QUIET_MS)}::timestamptz AT TIME ZONE 'UTC')`;
  if (answered === 0) return false;

  try {
    await enqueueWithin(queue, "planning", { shopId, campaignId }, PLAN_ENQUEUE_TIMEOUT_MS);
    return true;
  } catch (error) {
    // Kept as asked: the page shows the last numbers it has, says they are being redone, and
    // asks again once the ask goes quiet -- not on every load, each waiting on a Redis that
    // is not answering.
    logger.warn("a campaign's plan could not be handed to the worker", {
      shopId,
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ------------------------------------------------------------------ reading it

/** The stored preview as the page shows it: named and refused as the campaign is now. */
function shown(
  stored: Prisma.JsonValue,
  campaign: { name: string; status: string; ruleRows: unknown },
  asOf: Date,
  recomputing: string | undefined,
): CampaignPreview {
  const preview = stored as unknown as CampaignPreview;
  return {
    ...preview,
    // The heading and the state badge read the campaign as it is. A stale summary's rule
    // refusal is replaced by the stored rule's, which needs no plan and gates Apply (#818).
    name: campaign.name,
    status: campaign.status,
    ...(recomputing ? { refused: refusedRule(campaign.ruleRows).refused, recomputing } : {}),
    asOf: asOf.toISOString(),
  };
}

export interface PagePlan {
  preview: CampaignPreview;
  /** The rollback report stored with it, when the campaign has one and it has been worked out. */
  rollback: RollbackReport | null;
}

/**
 * The campaign page's preview and rollback report, without planning when a current one is
 * stored (#812).
 *
 * While a run writes the campaign, neither: what it changes is decided, and the page follows
 * the run (#803). Otherwise the stored answers when they are current; a fresh plan, stored,
 * when the scope is small or there is no worker; and for a large scope, the last answers with
 * the sentence saying they are being worked out again -- or none, saying one is on its way --
 * with the worker asked to plan it.
 */
export async function campaignPagePlan(
  shopId: string,
  campaignId: string,
  options: { client?: AdminClient; timeZone: string },
): Promise<PagePlan> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { name: true, status: true, ruleRows: true },
  });
  if (PLAN_IN_FLIGHT.has(campaign.status)) {
    return { preview: planlessPreview(campaignId, campaign, { writing: writingText(campaign.status) }), rollback: null };
  }

  const now = new Date();
  const row = await prisma.planSummary.findFirst({ where: { campaignId, shopId }, select: { ...STATE, preview: true, rollback: true } });
  const state = await stateOf(shopId, row, now);
  if (state === "current" && row?.preview && row.computedAt) {
    return { preview: shown(row.preview, campaign, row.computedAt, undefined), rollback: storedReport(row.rollback) };
  }

  const { queue, variants } = await whereToPlan(shopId, campaignId, campaign.status);
  if (!queue) {
    const fresh = await refreshPlanSummary(shopId, campaignId, options.client);
    return { preview: fresh.preview, rollback: fresh.rollback };
  }

  await requestPlan(shopId, campaignId, queue, now);
  if (state === "stale" && row?.preview && row.computedAt) {
    return {
      preview: shown(row.preview, campaign, row.computedAt, recomputingText(row.computedAt, options.timeZone)),
      rollback: storedReport(row.rollback),
    };
  }
  return { preview: planlessPreview(campaignId, campaign, { planning: planningText(variants) }), rollback: null };
}

function storedReport(value: Prisma.JsonValue | null | undefined): RollbackReport | null {
  return value ? (value as unknown as RollbackReport) : null;
}

/**
 * The preview an Apply press is checked against (#812): the stored one, never a plan of its
 * own once one is current.
 *
 * Not current, and too large to plan here: the stored one with `recomputing` set, or with
 * none stored, a preview with `planning` set and nothing in it. Over either the press asks
 * for the word -- the dialog showed those numbers as out of date, or offered no Apply at all
 * -- and asks nothing of the worker: the page that shows the campaign does that. A stored
 * number can make the press ask when it need not; whether it is skipped is decided again by
 * the run, on the plan that decides what it writes (`refuseUntypedPress`).
 */
export async function pressPreview(shopId: string, campaignId: string, client?: AdminClient): Promise<CampaignPreview> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { name: true, status: true, ruleRows: true },
  });
  const now = new Date();
  const row = await prisma.planSummary.findFirst({ where: { campaignId, shopId }, select: { ...STATE, preview: true } });
  const state = await stateOf(shopId, row, now);
  if (state === "current" && row?.preview && row.computedAt) return shown(row.preview, campaign, row.computedAt, undefined);

  const { queue, variants } = await whereToPlan(shopId, campaignId, campaign.status);
  if (!queue) return (await refreshPlanSummary(shopId, campaignId, client)).preview;
  if (state === "stale" && row?.preview && row.computedAt) {
    // "UTC" only for a sentence nobody reads here: the press needs the flag, not the words.
    return shown(row.preview, campaign, row.computedAt, recomputingText(row.computedAt, "UTC"));
  }
  return planlessPreview(campaignId, campaign, { planning: planningText(variants) });
}

/**
 * Who keeps which variants once this campaign is reverted, for the Revert dialog (#812).
 *
 * Stored with the rest of the plan and read: the last answer when it is not current, marked
 * so, rather than a plan of the whole scope as the dialog opens. Worked out here only when
 * none is stored and the scope is small enough, or there is no worker.
 */
export async function revertKeepers(shopId: string, campaignId: string, client?: AdminClient): Promise<KeepersAfterRevert> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true } });
  if (!campaign) return { repriced: 0, keepers: [] };

  const now = new Date();
  const row = await prisma.planSummary.findFirst({ where: { campaignId, shopId }, select: { ...STATE, preview: true, keepers: true } });
  if (row?.keepers) {
    const keepers = row.keepers as unknown as KeepersAfterRevert;
    return (await stateOf(shopId, row, now)) === "current" ? keepers : { ...keepers, recomputing: true };
  }

  // Nothing to revert, or a run writing it: the dialog that asks is not open.
  if (!REVERTABLE.has(campaign.status)) return { repriced: 0, keepers: [] };

  const { queue } = await whereToPlan(shopId, campaignId, campaign.status);
  if (!queue) return (await refreshPlanSummary(shopId, campaignId, client)).keepers ?? { repriced: 0, keepers: [] };
  await requestPlan(shopId, campaignId, queue, now);
  return { repriced: 0, keepers: [], recomputing: true };
}

/**
 * The whole rollback report, for its export: the stored one when it is current, and worked
 * out again when it is not. An export is what a merchant keeps as the record of what
 * reverting does, so it is never a stale one; the campaign page carries only the rows its tab
 * renders (#812), and this is where every other row is read.
 */
export async function currentRollback(shopId: string, campaignId: string): Promise<RollbackReport> {
  const row = await prisma.planSummary.findFirst({ where: { campaignId, shopId }, select: { ...STATE, preview: true, rollback: true } });
  const stored = storedReport(row?.rollback);
  // Not one stored before its market prices had rows (#1171): it names them, and has none to export.
  const rowless = stored?.marketsNotBefore !== undefined && stored.marketRows === undefined;
  if (stored && !rowless && (await stateOf(shopId, row, new Date())) === "current") return stored;
  return rollbackReport(shopId, campaignId);
}

/**
 * Asks the worker for this campaign's plan, when its scope is too large to plan in a request
 * and no plan of it is current or on its way: as a campaign is created (#812), so its first
 * page load finds one ready or coming. Never throws -- a page that loads later asks again.
 */
export async function requestPlanSummary(shopId: string, campaignId: string): Promise<void> {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true } });
    if (!campaign || PLAN_IN_FLIGHT.has(campaign.status)) return;
    const { queue } = await whereToPlan(shopId, campaignId, campaign.status);
    if (queue) await requestPlan(shopId, campaignId, queue);
  } catch (error) {
    logger.warn("could not ask for a campaign's plan", {
      shopId,
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ------------------------------------------------------------------ the worker's half

/**
 * The worker's planning job: plans the campaign and stores it, unless a current plan is
 * stored already -- a page planned it meanwhile, or the job was delivered twice.
 *
 * Not while a run writes the campaign: what it changes is decided, the page shows the run,
 * and the run's own writes make any plan made now stale before it is read. The ask is
 * cleared, so the page that loads once the run ends asks again.
 */
export async function runPlanningJob(shopId: string, campaignId: string, client: AdminClient | null): Promise<void> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true } });
  if (!campaign) return;
  if (PLAN_IN_FLIGHT.has(campaign.status)) {
    await prisma.planSummary.updateMany({ where: { campaignId }, data: { requestedAt: null } });
    return;
  }
  if ((await planSummaryState(shopId, campaignId)) === "current") return;

  try {
    await refreshPlanSummary(shopId, campaignId, client ?? undefined, "worker");
  } catch (error) {
    // Deleted while it was planned: nothing left to store a plan for.
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2025" || error.code === "P2003")) return;
    throw error;
  }
}

/**
 * The state of this campaign's stored plan, for the page following a background plan: when
 * the newest was made, and whether one is still on its way. One indexed read, scoped to the
 * session's shop in the query itself.
 */
export async function planStatus(
  shop: { domain: string },
  campaignId: string,
  now = new Date(),
): Promise<{ at: string | null; waiting: boolean }> {
  const row = await prisma.planSummary.findFirst({
    where: { campaignId, shop: { domain: shop.domain } },
    select: { computedAt: true, requestedAt: true },
  });
  return { at: row?.computedAt?.toISOString() ?? null, waiting: row ? !shouldRequest(row, now) : false };
}

/**
 * Deletes logged writes older than any summary could still be current about, a batch at a
 * time, from the scheduler's tick: the log has a row per statement for every writer in every
 * shop, and nothing else bounds it. Safe because a summary planned before the oldest row kept
 * is past `PLAN_SUMMARY_MAX_AGE_MS`, stale whatever the log says.
 */
export async function prunePlanInputChanges(now: Date = new Date(), batch = 5_000): Promise<number> {
  const cutoff = new Date(now.getTime() - PLAN_INPUT_RETENTION_MS);
  return prisma.$executeRaw`
    DELETE FROM "plan_input_changes"
    WHERE "id" IN (
      SELECT "id" FROM "plan_input_changes" WHERE "at" < (${cutoff}::timestamptz AT TIME ZONE 'UTC') ORDER BY "at" LIMIT ${batch}
    )`;
}
