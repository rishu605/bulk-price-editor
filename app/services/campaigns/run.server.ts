/**
 * Applying and reverting a campaign.
 *
 * The ordering here is the product's central safety property: ledger rows are
 * written **before** any Admin API call (invariant I4). If the process dies between
 * the two, verification finds an unverified row and retries. The other order would
 * change a merchant's storefront with no record that we did it, which is
 * unrecoverable and is precisely how competitors end up unable to explain
 * themselves.
 */

import type { Prisma } from "@prisma/client";

import {
  BULK_POLL_INTERVAL_MS,
  BULK_WAIT_MS,
  BulkSubmissionError,
  type BulkOperationState,
} from "../../lib/execution/bulk-executor";

import prisma from "../../db.server";
import { countOf, formatAgo, formatCount } from "../../lib/format/display";
import { CLAMP_REASONS } from "../../lib/campaigns/clamp-reasons";
import { unappliableRule } from "../../lib/campaigns/rule-limits";
import { marketScope } from "../../lib/planning/market-scope";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { executeRows } from "./execute.server";
import type { PlannedRow } from "../../lib/planning/types";
import { planRun } from "../../lib/planning/plan";
import { recordWriteIntents, resolveOverwrittenDrift } from "../drift.server";
import { loadCandidates, productMapFor, withWritten } from "./candidates.server";
import { revertTakesBack } from "./handover.server";
import { editedVariants } from "./rollback-report.server";
import { refreshBasePrices } from "../live-prices.server";
import { DEFINITION, isPractice, loadCampaignContext, scopeOf, importIdsOf, segmentGone } from "./model.server";
import { astToWhere } from "../segments.server";
import { DEFAULT_THRESHOLD, selectWritePath } from "../../lib/planning/write-path";
import {
  CARRY_FAILURES,
  chunkRowsFor,
  plannedRowOf,
  RUN_CHUNK_ROWS,
  type ChunkCarry,
} from "../../lib/execution/run-chunks";
import type { ResolvableCampaign } from "../../lib/pricing/types";
import { AppError, toAppError } from "../../lib/errors/app-error";
import { classifyFailure } from "../../lib/execution/classify";
import { LANDED } from "../../lib/execution/landed";
import { guardrailsFor } from "../settings.server";
import type { RunOutcome } from "./types";
import { chunk } from "../../lib/db/chunk";
import { inRunChunks, retryTransient, RUN_CHUNK } from "../../lib/db/run-writes.server";
import { handedOver, type InlineLimit, type InlineWork } from "../../lib/execution/inline-budget";
import { smallRun } from "../../lib/execution/run-lane";
import { leaseHolder, runLeaseHolder, takeShopLease, type ShopLease } from "../shop-lease.server";
import { recordClaim, releaseClaim, transitionCampaign } from "./lifecycle.server";
import { endingLateWatch } from "./ending-late.server";
import { clearQueuedRefused, recordEndMissed, recordQueuedRefused, recordStartRefused } from "./start-refusal.server";
import { refuseUnconfirmedStart, refuseUntypedPress } from "./start-confirmation.server";
import { clearEndedWindow } from "./schedule-control.server";
import { startsUnattended } from "../../lib/audit/actor";
import { queuedVerb } from "../../lib/campaigns/queued-refusal";
import { editsLeft } from "../../lib/campaigns/kept-edits";
import { refusedForGood, startRefusedEntry } from "../../lib/scheduling/start-refusal";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { breachPolicyFor } from "../../lib/campaigns/breach-policy";
import { SKIP_REASON_GROUP } from "../../lib/planning/reasons";
import { baseRowsOnly, type LedgerState, planResume } from "../../lib/execution/resume";
import { applyCampaignTags, applyTakeoverTags, removeCampaignTags } from "./tags.server";
import {
  applyMarketSurfaces,
  captureMarketBaselinesFirst,
  outstandingMarketRows,
  revertMarketSurfaces,
} from "./market-surfaces.server";
import { notify } from "../notifications.server";
import { settleMirror } from "./mirror.server";
import { noteBulkWait } from "./bulk-wait.server";
import { HEARTBEAT_EVERY_MS } from "./reaper.server";
import { metric } from "../../lib/telemetry/metrics";
import { addLogContext, withLogContext } from "../../lib/logging/context.server";
import { describeBlocked } from "./blocked.server";

export interface RunOptions {
  revert?: boolean;
  /**
   * Set by the worker for a run the web process or Flow claimed and handed it (#1046). One
   * that ends before it writes is said on the campaign and told once: the merchant, or Flow's
   * run log, had already been told it was under way.
   */
  queued?: boolean;
  /**
   * Who asked for this run, recorded on every transition it makes and anything it resolves
   * on their behalf (#755, #746): `actorFor(...)` for a person, `SCHEDULER_ACTOR` for the
   * scheduler, `FLOW_ACTOR` for Flow. Required, so no caller can leave it to a default.
   */
  actor: string;
  /**
   * The state the caller moved this campaign out of when it claimed it.
   *
   * Only the scheduler needs this. It claims a campaign with its own conditional
   * update -- that update *is* how two overlapping ticks avoid both running the same
   * transition -- so by the time `runCampaign` looks, the original state is gone. If
   * planning then fails, this is the only record of where to put the campaign back.
   *
   * A manual apply leaves it unset: the campaign is still in its pre-claim state when
   * `runCampaign` reads it.
   */
  claimedFrom?: CampaignState;
  /**
   * The history's reason for the scheduler's claim, when taking it went unrecorded because
   * it retried an attempt that gave the claim back (#829); see `claimForSchedule`. Recorded
   * once this run holds its occurrence, so the history reads claim, run, finish in order,
   * and a retry refused again adds nothing to it.
   */
  claimUnrecorded?: string;
  /**
   * What the caller lets a run do before answering (D29, #808): how many variants it may
   * cover and how long it may take. A larger run -- or one that goes to Shopify's bulk queue,
   * which has no estimate -- is handed to the background worker instead of starting here,
   * as a QUEUED run row the worker picks up (`queueRun`).
   *
   * Set only by `startRun`, the one way a route starts a run: the campaign page's
   * `PAGE_INLINE`, Flow's `NEVER_INLINE`. Left unset by the worker and the scheduler, which
   * have no request attached -- the ceiling is a property of the caller, not of the
   * campaign. See `inline-budget.ts`.
   */
  inline?: InlineLimit;
  /**
   * The QUEUED run row this run is, when the web process handed it over (#808). The worker's
   * run takes it out of QUEUED (`adoptQueuedRun`) rather than creating a row of its own, so the
   * row the page has followed since the press is the one that writes, and a job rung twice
   * runs once. One that ends before it writes is closed as CANCELLED (`cancelUnstartedRun`).
   */
  runId?: string;
  /**
   * Fraction of applied rows to read back. Defaults to full verification, which
   * suits the catalogue sizes the sync path handles; the bulk path compares every row
   * against the price its result file reports, so it does not sample.
   */
  verifySampleRate?: number;
  /**
   * Forces the write path instead of choosing it by row count.
   *
   * For tests and diagnostics only. Both paths must behave identically on the things
   * that matter, and the cheapest way to keep that true is to be able to run the same
   * scenario down each of them without seeding a thousand variants.
   */
  forcePath?: "sync" | "bulk";
  /**
   * How long a bulk run waits for Shopify before it stops watching, in place of the
   * poll's thirty minutes.
   *
   * For tests only: the chaos suite cannot wait half an hour to prove what happens when an
   * operation outlives the wait (#832).
   */
  bulkWaitMs?: number;
  /**
   * Continue an interrupted run instead of starting fresh.
   *
   * Rows the previous attempt verified are left untouched, so a resumed run converges
   * on the state a clean run would have produced (E2) without paying to rewrite work
   * that already landed.
   *
   * A whole revert resumed leaves alone every price the revert it continues kept as edited
   * (#1157), with the reason it was kept: nobody is asked again, so the answer stays theirs.
   */
  resume?: boolean;
  /**
   * Identifies which occurrence this run is, so a duplicate tick cannot start a
   * second one. Defaults to the current instant, which is right for a manual apply.
   */
  occurrenceKey?: string;
  /**
   * Restricts the run to these variants.
   *
   * A variant-level revert would otherwise replan the entire campaign to fix one row,
   * which on a large catalogue costs more than the operation it is performing. The
   * planner still resolves against every campaign, so the row lands where full
   * resolution would have put it -- the scope narrows what is examined, never how it
   * is decided.
   */
  variantGids?: string[];
  /**
   * Variants to leave exactly as they are, recorded rather than silently dropped.
   *
   * This is the rollback report's "keep the merchant's edit". Somebody changed the
   * price by hand while the campaign was running, and reverting would overwrite a
   * deliberate decision. The rows still land in the ledger as SKIPPED with the reason
   * attached, because "we chose not to touch these" is exactly the kind of thing that
   * has to be explainable six weeks later.
   */
  skipVariantGids?: string[];
  /** Why `skipVariantGids` were left alone, for their ledger rows. */
  skipReason?: string;
  /**
   * Leave every variant the rollback report lists as edited, as a merchant keeping each edit
   * would, ledgered as spared with `skipReason` (#794). Set by Shopify Flow's End campaign,
   * which has nobody to ask: the Revert button refuses to revert over an edit without a
   * review, and Flow wrote over every one.
   *
   * Worked out by the run that writes, on a whole revert only: here for one that fits the
   * request, in the worker for one handed there, so it is what is edited when the revert runs
   * and Flow's ten seconds never wait on a report of the whole campaign.
   */
  keepEdited?: boolean;
  /**
   * An Apply pressed on the campaign page without "apply" typed (#812). The press was let
   * through on the campaign's stored preview, which did not ask for the word; this run checks
   * its own plan, and refuses before writing if that plan asks after all. Carried to the
   * worker for a run handed there.
   */
  untypedPress?: boolean;
  /**
   * The caller can give the run back to its lane between chunks (#809, D34): set by the worker's
   * run-lane jobs, and only there. A whole-campaign run of more than `RUN_CHUNK_ROWS` prices on
   * Shopify's bulk path then plans and ledgers every price in this call and answers `continues`,
   * and its prices are written a chunk a turn by `continueChunkedRun`. Unset -- the campaign page,
   * the tick given no queue, a script -- and every run is written here, whole, as it always was.
   */
  turns?: boolean;
}

export async function runCampaign(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions,
): Promise<RunOutcome> {
  // The campaign is moved to APPLYING before anything is planned, so that an illegal
  // action is refused before a price moves. Planning can then fail -- a guardrail
  // blocks the run, a session expires, a catalogue outgrows one statement -- and until
  // this wrapper existed every one of those left the campaign claiming to be applying
  // forever, with an empty ledger behind it and revert refused.
  //
  // The guardrail case is the common one, not an exotic one: `planRun` returning
  // `blocked` throws, so a floor price doing exactly its job stranded the campaign.
  //
  // Read before the claim, because afterwards the original state is gone. When the
  // scheduler claimed the campaign itself -- its `updateMany` from SCHEDULED is how two
  // overlapping ticks avoid both running the same transition -- this reads APPLYING and
  // only the scheduler knows what it took, so it passes `claimedFrom`.
  const before = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  const stateBefore = (options.claimedFrom ?? before?.status) as CampaignState | undefined;

  // Set by `executeCampaignRun` as soon as the run row exists; read by the catch below.
  const started: Started = {};
  // Where a claim given back goes: where the campaign was before it, unless the run moved it
  // first -- a scheduled campaign whose window had ended is a draft by its claim (#1146).
  const releaseTarget = () => started.releaseTo ?? stateBefore;

  // A run the web process queued is its row (#808). Only the worker that takes it out of
  // QUEUED runs it: a job rung twice -- the tick's ring and Redis's late delivery -- stands down
  // to the one that did, having touched nothing.
  // Imported where it is used, as `queueRun` always was: the queue's module brings BullMQ.
  const queued = options.runId ? await import("./queued-run.server") : null;
  if (options.runId && !(await queued!.adoptQueuedRun(options.runId))) {
    return {
      runId: options.runId,
      planned: 0,
      verified: 0,
      failed: 0,
      unverified: 0,
      clean: true,
      deferredTo: options.runId,
      messages: ["This queued run was already picked up by the background worker. Nothing was written twice."],
    };
  }
  // Planned before a price is written, and at 102,132 variants planning is minutes (#803):
  // stamped while it lasts, so the reaper never takes a run being planned for one that died.
  // Conditional on PLANNING, so once the run writes its own heartbeat takes over.
  const planning = options.runId ? planningBeat(options.runId) : null;
  // A queued run that ends before it writes is closed as never started -- and before the
  // claim is given back, which a live row would block.
  const dropIfUnstarted = async () => {
    if (options.runId && !started.runId) await queued!.cancelUnstartedRun(options.runId);
  };

  try {
    // Every line this run produces carries the shop and the campaign, and the run id
    // from the moment there is one. Bound here rather than in the worker because this is
    // the function both callers share: a queued apply arrives through the job wrapper,
    // an inline Apply or Revert arrives straight from a route, and per CLAUDE.md rule 2
    // both genuinely write. Binding at the job alone would have left the web half — the
    // half a merchant is watching — with no ids at all.
    //
    // Merges with the job's context when there is one, so a queued run keeps its job id.
    // A queued run's job binds its run id from the ref before it gets here (`traced`).
    const outcome = await withLogContext({ shopId, campaignId }, () =>
      executeCampaignRun(shopId, campaignId, client, options, started, stateBefore),
    ).finally(() => planning && clearInterval(planning));
    await dropIfUnstarted();

    // A refusal -- waiting for approval, over the inline limit, refused by the plan -- is
    // a return, not a throw, so the catch below never saw it. When the scheduler had
    // claimed the campaign, it stayed APPLYING with nothing behind it: the sale never
    // started, approving it later changed nothing, and nothing ever reverted it (#701).
    // Released back to where the scheduler took it from, so the next tick asks again.
    // A full run that stood down for a scoped one (#763) took its claim itself, so it
    // gives it back whoever started it.
    if (options.queued && outcome.refused && !outcome.deferredTo) {
      await recordQueuedRefused(shopId, campaignId, { verb: queuedVerb(options), reason: outcome.refused }, { tell: true });
    }
    const releaseTo = releaseTarget();
    if (
      outcome.refused &&
      releaseTo &&
      (options.claimedFrom || outcome.deferredTo) &&
      releaseTo !== "APPLYING" &&
      releaseTo !== "REVERTING"
    ) {
      await releaseClaim(shopId, campaignId, releaseTo, {
        reason: outcome.refused,
        actor: options.actor,
        // The scheduler asks every tick while the reason stands. One activity entry
        // says why; a new one every thirty seconds would bury it.
        quietIfRepeated: true,
      });
    }

    return outcome;
  } catch (error) {
    if (planning) clearInterval(planning);
    await dropIfUnstarted().catch(() => {});
    // A bulk submission Shopify refused sent nothing, however far the run had got (#1054): a run
    // that waited its whole wait for a turn, or any other refusal. Nothing went before it -- on
    // the bulk path it is the first write -- so the run did not stop part-way, and "This apply
    // stopped part-way. Some prices may have changed" over it was untrue.
    const writing = started.writing === true && !(error instanceof BulkSubmissionError);
    return endFailedRun(shopId, campaignId, options, { runId: started.runId, writing, releaseTo: releaseTarget() }, error);
  } finally {
    // The shop's run lease a page-written run took (#809), however it ended.
    await started.lease?.release();
  }
}

/**
 * Ends a run that threw, and says so: its row terminal, the merchant told, and the campaign
 * Partial when prices may have changed or its claim given back when none did. Then throws, the
 * merchant's sentence when it stopped part-way and the original otherwise. Shared by a run
 * written in one call (`runCampaign`) and a chunked run's turn (`continueChunkedRun`, D34), so a
 * run that stops in its fifth chunk ends exactly as one that stops five thousand rows in.
 */
async function endFailedRun(
  shopId: string,
  campaignId: string,
  options: RunOptions,
  ended: {
    /** The run row, once there is one. */
    runId: string | undefined;
    /** Whether prices may have changed: from here a failure leaves the campaign Partial (#802). */
    writing: boolean;
    /** Where a claim given back goes. */
    releaseTo: CampaignState | undefined;
  },
  error: unknown,
): Promise<never> {
  const { writing, releaseTo } = ended;
  // The run row reaches a terminal state before anything else happens. Without this a
  // throw between creating the row and the update at the end of `executeCampaignRun`
  // left it EXECUTING for ever: `releaseClaim` below frees the *campaign*, so nothing
  // looked stuck, and the run sat in the ledger claiming to be in progress with no
  // process behind it. #649 found it on the bulk path, where a refused submission
  // throws straight past the terminal update, but the gap was never specific to that
  // path — every `await` after the row is created had it.
  const failed = await failRun(ended.runId, error, writing);
  if (failed?.ended) await notifyRunFailed(shopId, campaignId, options, failed, error, writing, ended.runId);

  // It wrote, then threw (#802). Handing the campaign back to where it started -- Draft,
  // for a manual apply -- told the merchant "nothing has been written to your storefront"
  // over 54,168 prices at 10% off, nothing owned them, and Revert does not work on a
  // draft. The honest state is Partial, with what the ledger says landed, and the message
  // says prices changed. Only when this throw ended the run: one after it completed --
  // the mirror refresh, a notification -- leaves the finished run's state alone. A run
  // over named variants never held the campaign, so it has no state to move.
  if (failed?.ended && writing && !options.variantGids) {
    try {
      await transitionCampaign(shopId, campaignId, "PARTIAL", {
        reason:
          `${options.revert ? "revert" : "apply"} stopped part-way, after ${failed.verified} of ${failed.planned} ` +
          `prices were changed and read back: ${toAppError(error).userMessage}`,
        runId: ended.runId,
        actor: options.actor,
      });
    } catch (transitionError) {
      const { logger } = await import("../../lib/logging/logger");
      logger.error("a run stopped part-way and its campaign could not be marked partial", {
        campaignId,
        runId: ended.runId,
        error: transitionError instanceof Error ? transitionError.message : String(transitionError),
      });
    }
    throw stoppedPartWay(error, failed, options);
  }

  // Only release to a state that is not itself a claim. A campaign that was already
  // APPLYING when this was called -- a resume, a second worker -- has nowhere to be
  // put back to, and `releaseClaim` additionally refuses while any run is still live.
  if (releaseTo && releaseTo !== "APPLYING" && releaseTo !== "REVERTING") {
    // A scheduled start refused for a reason no retry changes -- its segment deleted, a
    // blocking guardrail (#975). Put back to SCHEDULED as before, the claim being the
    // scheduler's to give back, but marked first: the next tick claimed it again, was
    // refused again, and wrote both to its history every thirty seconds while its window
    // stayed open. Marked before the release, so no tick sees it SCHEDULED and unmarked.
    const forGood = options.claimedFrom === "SCHEDULED" ? refusedForGood(error) : null;
    if (forGood) await recordStartRefused(shopId, campaignId, forGood.userMessage, { tell: !failed?.ended });
    // A queued run that never got to write, whatever stopped it (#1046): the job is not
    // tried again, so a blip is as final for it as a refusal.
    if (options.queued) {
      const refusal = { verb: queuedVerb(options), reason: toAppError(error).userMessage };
      await recordQueuedRefused(shopId, campaignId, refusal, { tell: !failed?.ended });
    }
    // A scheduled end that could not run is retried, but said once, on the page and by
    // email (#1005): the sale's prices are still live past its window. The scheduler's only:
    // a revert handed to the worker carries its claim too, and is said above (#808).
    if (options.claimedFrom && options.revert && !options.queued) {
      await recordEndMissed(shopId, campaignId, toAppError(error).userMessage, { tell: !failed?.ended });
    }
    await releaseClaim(shopId, campaignId, releaseTo, {
      // The merchant's sentence from the error taxonomy, never the raw message (#1005):
      // "fetch failed" in a campaign's history tells its reader nothing they can act on.
      reason: forGood ? startRefusedEntry(forGood.userMessage) : toAppError(error).userMessage,
      actor: options.actor,
      // A blip is retried every tick while it lasts, as an early refusal is: one entry says
      // why, and a new one every thirty seconds would bury it.
      quietIfRepeated: options.claimedFrom !== undefined,
    });
  }
  throw error;
}

/** A bulk operation's state as its record keeps it: status, how far it has got, and when it ended. */
function bulkProgress(operation: BulkOperationState) {
  // Anything Shopify reports that the record has no word for (CANCELING) is still running.
  const status = (
    ["CREATED", "RUNNING", "COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status) ? operation.status : "RUNNING"
  ) as "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "EXPIRED";
  const count = Number(operation.objectCount ?? Number.NaN);
  return {
    status,
    ...(Number.isFinite(count) ? { objectCount: BigInt(Math.trunc(count)) } : {}),
    ...(operation.url ? { resultUrl: operation.url } : {}),
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
    ...(status !== "CREATED" && status !== "RUNNING" ? { finishedAt: new Date() } : {}),
  };
}

/** Filled in as a run gets going, for the catch in `runCampaign`. */
interface Started {
  /** The run row, once it exists. */
  runId?: string;
  /** Set as the first price is sent: from here, a failure may have changed the storefront. */
  writing?: boolean;
  /** Where a claim given back goes, when the run moved the campaign before claiming it (#1146). */
  releaseTo?: CampaignState;
  /** The shop's run lease, held by a run the campaign page writes itself (#809). */
  lease?: ShopLease;
}

interface FailedRun {
  /** Whether this call ended the run, rather than finding it already finished. */
  ended: boolean;
  /** Rows written and read back (VERIFIED or CLAMPED). */
  verified: number;
  /** Rows written and never read back. */
  applied: number;
  /** Rows inside a bulk operation Shopify accepted, outcome not yet read (#832). */
  sent: number;
  /** Rows Shopify refused or the read-back disagreed with. */
  failed: number;
  planned: number;
}

/**
 * Marks a run terminal after it threw, so the ledger never shows work that is not happening.
 *
 * Three things it deliberately does not do.
 *
 * It does not throw. This runs inside a catch whose job is to rethrow the *original*
 * failure; a database hiccup here replacing a refused Shopify submission with a Prisma
 * error would lose the only useful sentence the merchant was going to get.
 *
 * It does not touch a run that already reached a terminal state. The catch in
 * `runCampaign` covers everything after the row is created, including the lines *after*
 * the run is marked COMPLETED — `transitionCampaign`, the mirror refresh — and a throw
 * there must not rewrite a finished run as FAILED. The `status` filter is what makes
 * this safe to call unconditionally rather than only from the paths known to be early.
 *
 * It does not guess counts. A run that died mid-flight has whatever `variant_changes`
 * recorded before it stopped, and that ledger is the truth. It used to write nothing at
 * all, so a run with 55,000 verified rows read "Failed · 0 verified" (#802); it now copies
 * the ledger's counts onto the run. A run that had started writing is PARTIAL, not FAILED --
 * resumable, as a reclaimed run is -- and its rows caught mid-write go back to PENDING for
 * the resume to settle.
 */
async function failRun(runId: string | undefined, error: unknown, writing = false): Promise<FailedRun | null> {
  if (!runId) return null;

  try {
    const [verified, applied, failed, run] = await Promise.all([
      prisma.variantChange.count({ where: { runId, status: { in: [...LANDED] } } }),
      prisma.variantChange.count({ where: { runId, status: "APPLIED" } }),
      prisma.variantChange.count({ where: { runId, status: "FAILED" } }),
      prisma.campaignRun.findUnique({ where: { id: runId }, select: { plannedRows: true } }),
    ]);
    const ended = await prisma.campaignRun.updateMany({
      where: { id: runId, status: { in: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] } },
      data: { status: writing ? "PARTIAL" : "FAILED", finishedAt: new Date(), verifiedRows: verified, failedRows: failed },
    });
    let sent = 0;
    if (writing && ended.count > 0) {
      // Rows inside a bulk operation Shopify accepted are sent, not unsent: Shopify goes on
      // applying them, and a resume asks it how the operation ended (#832). Finished or not
      // -- a run that dies reading a 100,000-row result file has an operation that is done
      // and rows nobody has read back.
      const inBulk = await prisma.bulkOperationRecord.count({ where: { runId, kind: "MUTATION" } });
      if (inBulk === 0) {
        await prisma.variantChange.updateMany({ where: { runId, status: "WRITING" }, data: { status: "PENDING" } });
      } else {
        sent = await prisma.variantChange.count({ where: { runId, status: "WRITING" } });
      }
      await settleMirror(runId);
    }
    return { ended: ended.count > 0, verified, applied, sent, failed, planned: run?.plannedRows ?? 0 };
  } catch (failure) {
    // Imported here rather than at the top, matching the one other use in this file.
    const { logger } = await import("../../lib/logging/logger");
    logger.error("Could not mark run failed", {
      runId,
      cause: failure instanceof Error ? failure.message : String(failure),
      original: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * A run that stopped by throwing, emailed to a merchant who asked to hear about failures
 * (#710). `run-failed` had a template and a preference and no sender: `notify` was only
 * reached on a normal return, so a guardrail block, a lost session or a crash part-way
 * through reached nobody who had closed the tab. Best-effort, as every notification is:
 * telling the merchant must never change what happened.
 */
async function notifyRunFailed(
  shopId: string,
  campaignId: string,
  options: RunOptions,
  failed: FailedRun,
  error: unknown,
  writing: boolean,
  runId: string | undefined,
): Promise<void> {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
    void notify(shopId, {
      campaignId,
      kind: "run-failed",
      revert: options.revert === true,
      campaignName: campaign?.name ?? "Your campaign",
      counts: {
        verified: failed.verified,
        failed: failed.failed,
        unverified: failed.applied + failed.sent,
        skipped: 0,
        clamped: 0,
      },
      reasons: [writing ? stoppedPartWay(error, failed, options).userMessage : toAppError(error).userMessage],
    }, { runId });
  } catch {
    // Never let telling the merchant about a failure become a second one.
  }
}

/**
 * What the merchant is told when a run fails after it started writing (#802).
 *
 * The failure's own code, status and retryability are kept -- Flow and the worker decide on
 * those -- but its sentence is not: "The app's own database is not responding… Nothing was
 * changed in your store" was the message on a run that had changed 55,000 prices. This says
 * prices changed, how many, and the two ways forward.
 */
function stoppedPartWay(error: unknown, failed: FailedRun, options: RunOptions): AppError {
  const app = toAppError(error);
  const verb = options.revert ? "revert" : "apply";
  const changed = failed.verified + failed.applied;
  const what =
    changed > 0
      ? `${formatCount(changed)} of ${countOf(failed.planned, "price")} ${changed === 1 ? "was" : "were"} changed before it did, so your ` +
        "storefront has some of this campaign's prices and not others."
      : failed.sent > 0
        ? `${countOf(failed.sent, "price")} ${failed.sent === 1 ? "was" : "were"} sent to Shopify in bulk and may already be live.`
        : "Some prices may have changed before it did.";
  return new AppError({
    code: app.code,
    status: app.status,
    retryable: app.retryable,
    cause: error,
    context: { ...app.context, stoppedPartWay: true, verified: failed.verified, applied: failed.applied },
    userMessage:
      `This ${verb} stopped part-way. ${what} The campaign is now Partial: Resume to finish the ${verb}, ` +
      "or Revert to put every price back.",
  });
}

async function executeCampaignRun(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions,
  /**
   * Filled in the moment the run row exists, so the caller's catch can finish it.
   *
   * An out-parameter rather than a return value because the thing that needs it is the
   * failure path, which by definition never reaches a return. See `failRun`.
   */
  started: Started = {},
  /**
   * Where the campaign was before this run claimed it, which says whether the store's
   * floor-breach setting still reaches it (#1161): by the time it plans it is Applying.
   */
  stateBefore?: CampaignState,
): Promise<RunOutcome> {
  // Practice campaigns never write. Refused here, in the one function that writes
  // prices, rather than only in the UI that offers the button: the merchant was told
  // nothing would be written, and that has to hold against a scheduler tick, a stray
  // caller, or a future button somebody adds without knowing.
  const practising = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { ...DEFINITION, ruleRows: true },
  });
  if (practising && isPractice(practising)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "This is a practice campaign, so it cannot be applied — that is the point of it. " +
        // The page's button for it (#1077), where this told the merchant to rebuild it.
        "When you are ready, Make a real copy on its page: a draft with the same scope and rule, which can be applied.",
      context: { campaignId },
    });
  }
  // A campaign whose segment was deleted has nothing in scope (#776). Refused by name rather
  // than run as an empty apply that reads as "nothing to change". A revert still runs: it
  // takes back what the campaign wrote, whatever its scope says now.
  if (!options.revert && practising && (await segmentGone(shopId, practising))) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "This campaign's segment was deleted, so it has no products to price. Duplicate it " +
        "and choose a segment for the copy, or archive it.",
      context: { campaignId },
    });
  }
  // A reduction of 100% or more prices the whole scope at the smallest price (#818). The
  // editor refuses it as typed; a campaign stored before that, or by any other path, is
  // refused here, for the scheduler and Flow as much as the page. The preview says the same
  // sentence, so the page never offers the Apply. Never a revert: taking it back is allowed.
  const unappliable = options.revert ? null : unappliableRule(practising?.ruleRows);
  if (unappliable) throw new AppError({ code: "VALIDATION", userMessage: unappliable, context: { campaignId } });

  // Enter the running state here, before anything is planned or written, rather than
  // leaving it to each caller.
  //
  // It used to be the caller's job, and the campaign page forgot. Applying a draft
  // campaign wrote and verified every price, then threw on the illegal DRAFT -> ACTIVE
  // move at the very end -- leaving the storefront changed, the ledger full of
  // VERIFIED rows, and the campaign showing "Draft: nothing has been written to your
  // storefront". The app contradicting its own ledger about a merchant's live prices
  // is the exact failure this product exists to prevent, so the state machine now
  // rides with the run instead of being an instruction callers have to remember.
  //
  // Doing it first also means an illegal action -- reverting a draft, applying a
  // cancelled campaign -- is refused before a single price moves, and the state
  // machine's own message says which state blocked it.
  //
  // Scoped runs are exempt: reverting one variant out of a four-thousand-variant sale
  // says nothing about the campaign, and moving it to APPLYING would misreport the
  // other 3,999.

  // One writer per campaign, checked before anything is claimed or queued (#791). A run
  // the reaper wrongly took for dead left its campaign Partial with a Resume button while
  // it was still writing; pressing it started a second writer over the same rows. Whatever
  // the state says, a full run that has not finished is still the writer, so a Resume, an
  // Apply or a Revert waits for it. Transient: it clears on its own, and Flow's resend is
  // the retry it needs.
  if (!options.variantGids) {
    // Not this run's own row, when it is one the web process queued (#808).
    const live = await liveFullRun(campaignId, options.runId);
    if (live) return standDown(campaignId, live, options, 0);
  }

  // Before anything writes, asks Shopify how the campaign's last bulk operation ended
  // (#832). Its rows were sent and may be live. Still running, nothing writes: a revert
  // sent now would be overwritten as Shopify works through the apply, and a resume would
  // send the same prices twice. The variants it settles as landed never got their tags or
  // market prices -- the run died before either -- and a resume writes no base price for
  // them, so they are carried to both below.
  const settledLanded = new Set<string>();
  let settledNote: string | null = null;
  {
    const { settleSubmittedBulk } = await import("./execute.server");
    const bulk = await settleSubmittedBulk(shopId, campaignId, client);
    if (bulk && "stillRunning" in bulk) {
      return { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true, messages: [bulk.stillRunning], refused: bulk.stillRunning, transient: true };
    }
    if (bulk) {
      for (const gid of bulk.landed) settledLanded.add(gid);
      // Said first, because this run's own counts do not include them: "apply finished:
      // 0 verified" straight after reading four verified prices from Shopify read as if
      // nothing had happened.
      settledNote =
        `Shopify had finished bulk operation ${bulk.operation}: ${countOf(bulk.landed.length, "price")} read back from its result file` +
        (bulk.failed > 0 ? `, ${formatCount(bulk.failed)} failed` : "") +
        (bulk.unreported > 0 ? `, ${formatCount(bulk.unreported)} not in it` : "") +
        ".";
      await settleMirror(bulk.settledRunId);
      const [verified, failed] = await Promise.all([
        prisma.variantChange.count({ where: { runId: bulk.settledRunId, status: { in: [...LANDED] } } }),
        prisma.variantChange.count({ where: { runId: bulk.settledRunId, status: "FAILED" } }),
      ]);
      await prisma.campaignRun.update({ where: { id: bulk.settledRunId }, data: { verifiedRows: verified, failedRows: failed } });
    }
  }

  // What this run will write, for the inline limit (#790, D29). Counted only for a caller
  // that declared one, and only for a whole-campaign run: a scoped run is a handful of
  // variants by construction, and handing one to the worker would take the whole campaign's
  // claim for it.
  const work = options.inline && !options.variantGids ? await inlineWork(shopId, campaignId) : undefined;

  // ---------------------------------------------------------- the plan gate (E8)
  //
  // Applies only. A revert is never gated on any plan, ever: a merchant who downgrades
  // mid-campaign must still get their scheduled revert, and a store left at 40% off
  // because we stopped reverting is a revenue incident we caused. No amount of "they
  // downgraded" makes that defensible.
  //
  // Checked here rather than only in the wizard because a catalogue grows and a plan can
  // lapse between a campaign being created and the scheduler running it, and the
  // scheduler never goes near the wizard.
  if (!options.revert) {
    // Approval before plan. A campaign nobody has signed off should say so rather than
    // being refused for a plan reason the merchant would then go and fix, only to hit the
    // approval afterwards.
    const { blockedPendingApproval } = await import("../approvals.server");
    const unapproved = await blockedPendingApproval(shopId, campaignId);
    if (unapproved) {
      return {
        runId: "",
        planned: 0,
        verified: 0,
        failed: 0,
        unverified: 0,
        clean: true,
        messages: [unapproved],
        refused: unapproved,
      };
    }

    // How many variants this run will attempt: the count the budget already made, or the
    // plan gate counts for itself -- a subset apply's list through the scope, as it is priced.
    const refusal = await refusedByPlan(shopId, campaignId, { counted: work?.variants, only: options.variantGids });
    if (refusal) {
      return {
        runId: "",
        planned: 0,
        verified: 0,
        failed: 0,
        unverified: 0,
        // Clean, because nothing is half-done: no price moved and no ledger row exists.
        // Reporting this as unclean would put a campaign into the "needs attention"
        // queue for a reason the merchant cannot resolve by attending to it.
        clean: true,
        messages: [refusal],
        refused: refusal,
      };
    }
  }

  // A run larger than the caller writes while it waits goes to the worker instead of running
  // here (#772, #790, D29), after the approval and plan gates have had their say, and before
  // the claim below, because handing it over takes the claim itself.
  const tooLongHere = work && options.inline ? handedOver(work, options.inline) : null;
  // One run per shop at a time, the page's own included (#809): a run small enough to write
  // here takes the shop's lease first, and one that finds another of the shop's runs writing is
  // the worker's, which starts it the moment that one finishes. Released by `runCampaign`.
  let handOver = tooLongHere;
  if (!handOver && work && options.inline) {
    const lease = await takeShopLease(shopId, "run", { holder: leaseHolder("page"), campaignId });
    if (lease) started.lease = lease;
    else handOver = await shopBusyReason(shopId);
  }
  // Whether nobody is there to type the typed confirmation (#1009): checked below on the
  // run's own plan, and here first for a Flow start handed to the worker, which would
  // otherwise answer Flow "queued" and be refused where Flow never hears it.
  const unattendedStart = !options.revert && !options.variantGids && startsUnattended(options.actor);
  if (tooLongHere && unattendedStart) {
    await refuseUnconfirmedStart(shopId, await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }), options.actor);
  }

  // A hand apply of a campaign whose window has ended runs with no end (#1146). Kept, the end
  // was due the moment this apply finished, and the next tick reverted the sale it had just
  // started: "QA · 1h session", completed in a window five weeks gone, was on for a minute. Its
  // dates are cleared as Unschedule clears them, and a scheduled one becomes a draft, which a
  // claim given back then returns to. After the approval and plan gates, so a press they refuse
  // leaves it as it was, and before either claim below -- the worker's or this one -- so no
  // tick ever finds it applying past an end. Only a press or Flow: the scheduler's run and the
  // worker's arrive claimed, and a resume or a scoped run starts no sale.
  if (!options.revert && !options.resume && !options.variantGids && !options.claimedFrom) {
    started.releaseTo = (await clearEndedWindow(shopId, campaignId, options.actor)) ?? undefined;
  }
  if (handOver && work) {
    // Always queued from here, Redis or not (D29): the row is written, and the worker's tick
    // runs it if no job reaches the worker. Never refused for its size, and never run here.
    const { queueRun } = await import("./queued-run.server");
    const queued = await queueRun(shopId, campaignId, handOver, {
      revert: options.revert === true,
      resume: options.resume,
      actor: options.actor,
      skipVariantGids: options.skipVariantGids,
      skipReason: options.skipReason,
      keepEdited: options.keepEdited,
      untypedPress: options.untypedPress,
      scope: work.variants,
      // The lane, from the same count (#809): a run the page could have waited for is small.
      small: smallRun(work),
    });
    if (queued) return queued;
    // Already claimed, or a live run holds it: that run, by name, when there is one (#793).
    const live = await liveFullRun(campaignId);
    if (live) return standDown(campaignId, live, options, 0);
    const message = `This campaign is already being ${options.revert ? "reverted" : "applied"}. Nothing more was queued; this page shows that run as it goes.`;
    return { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true, messages: [message], deferredTo: "in-progress" };
  }

  if (!options.variantGids) {
    // Whoever asked, on every move the run makes for them (#912). Without it the record
    // falls back to "system", which the page shows as the Scheduler -- so an Apply pressed
    // by a merchant read as the app starting a sale on its own. A scheduled run passes
    // none and still records "system".
    await transitionCampaign(shopId, campaignId, options.revert ? "REVERTING" : "APPLYING", {
      reason: options.resume ? "resume requested" : options.revert ? "revert requested" : "apply requested",
      actor: options.actor,
    });
    // A queued run refused earlier is no longer the latest word on this campaign (#1046).
    await clearQueuedRefused(campaignId);

    // One writer at a time, whichever kind (rule 2, #763). A run over one variant never
    // takes this claim, so it cannot collide on it: it writes its run row first and then
    // looks for a claim, while this run has taken its claim and now looks for a run row.
    // Whichever looks second sees the other and stands down, and nothing is written twice.
    const scoped = await liveScopedRun(campaignId);
    if (scoped) {
      const message =
        "A change to one variant of this campaign is being written right now, so nothing was " +
        "written. Try again in a minute, once it has finished.";
      return {
        runId: "",
        planned: 0,
        verified: 0,
        failed: 0,
        unverified: 0,
        clean: true,
        messages: [message],
        refused: message,
        deferredTo: scoped.id,
        transient: true,
      };
    }
  }

  const startedAt = Date.now();
  const { campaign: campaignRecord, resolvable, heldEdits, ast, breach } = await loadCampaignContext(shopId, campaignId);
  const campaignName = campaignRecord.name;
  const [scoped, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast, options.variantGids, importIdsOf(resolvable)),
    guardrailsFor(shopId),
  ]);

  // A whole-campaign revert takes back every price this campaign wrote, not only the ones
  // still inside its scope (#828, edge case E6): a variant untagged mid-campaign keeps the
  // sale price otherwise, and nothing else would ever revert it. And every price another
  // campaign's revert handed it (#998), which its own ledger never recorded.
  const wholeRevert = options.revert === true && !options.variantGids;
  const written = wholeRevert ? await revertTakesBack(shopId, campaignId) : [];
  const plan = async (base: typeof scoped) => {
    // The same helper both revert previews use, so neither says a product archived mid-sale
    // "reverts to" its sale price while this puts its baseline back (#751).
    const candidates = await withWritten(shopId, base, written, importIdsOf(resolvable));
    return {
      candidates,
      outcome: planRun({
        campaigns: resolvable,
        candidates,
        storeGuardrails,
        // Whose run: one that prices only its markets plans no base price (#1094).
        campaignId,
        excludeCampaignId: options.revert ? campaignId : undefined,
        heldEdits,
      }),
    };
  };
  let { candidates, outcome } = await plan(scoped);

  // The ones this revert is about to leave alone are asked of Shopify, not of the mirror
  // (#828). A scheduled sale's end planned zero rows from a mirror that said "baseline",
  // marked the campaign "Completed · prices are back", and every sale price stayed live.
  // Asked only about those -- a revert over a correct mirror plans every variant it wrote
  // and pays nothing for this. Where the mirror was wrong, it is corrected and the revert
  // planned again from what Shopify holds.
  let unplanned: string[] = [];
  if (wholeRevert && outcome.kind === "ok" && written.length > 0) {
    const planned = new Set(outcome.rows.filter((row) => row.ref.priceListGid === "").map((row) => row.ref.variantGid));
    const skippedOver = written.filter((gid) => !planned.has(gid));
    const corrected = await refreshBasePrices(shopId, client, skippedOver);
    if (corrected.size > 0) {
      const replanned = await plan(await loadCandidates(shopId, ast, options.variantGids, importIdsOf(resolvable)));
      candidates = replanned.candidates;
      outcome = replanned.outcome;
    }
    // Still nowhere to plan them from: no baseline to return to. Said, and the revert
    // ends Partial rather than claiming prices are back.
    const plannable = new Set(candidates.map((candidate) => candidate.ref.variantGid));
    unplanned = written.filter((gid) => !plannable.has(gid));
  }

  // Each blocking variant by name, with its price, its floor and what to do (#1076): the
  // history, the scheduler's refusal and Flow's run log all read this sentence. What to do is
  // asked of the state before this run's claim (#1161): a draft's claim is given back and the
  // store's setting reaches it again, while a running campaign keeps its policy. None for a
  // revert, as for its preview: what stops it is another campaign's policy, and the sentence
  // names that campaign, as it does one that outranks this one on a variant (#1169).
  if (outcome.kind === "blocked") {
    const told = options.revert || !stateBefore ? undefined : breachPolicyFor(stateBefore, breach.policy, breach.store);
    throw new AppError({
      code: "GUARDRAIL_BLOCKED",
      userMessage: await describeBlocked(shopId, outcome.blocked, "run", { campaignId, breach: told }),
      context: { campaignId, blocked: outcome.blocked.length, firstVariantGid: outcome.ref.variantGid, reason: outcome.reason },
    });
  }

  // A start nobody is there to confirm (#1009): the scheduler's, or Flow's. Over the store's
  // typed-confirmation thresholds the Apply button asks for the word; these cannot, so the
  // campaign must carry a confirmation that covers what this plan writes. Checked on this
  // plan, before the run row, so a refusal writes nothing and is a refusal for good.
  if (unattendedStart) {
    await refuseUnconfirmedStart(shopId, campaignRecord, options.actor, { ...outcome, candidates, campaigns: resolvable });
  }
  // An Apply pressed without the word over a stored preview that did not ask for it (#812):
  // the same check, on this plan, so a stale stored number can never be what skipped it.
  if (options.untypedPress && !options.revert && !options.variantGids) {
    await refuseUntypedPress(shopId, campaignId, { ...outcome, candidates, campaigns: resolvable });
  }

  const kind = options.revert ? "REVERT" : "APPLY";
  // Flow's End campaign keeps what the Revert tab would have asked about (#794): every price
  // the rollback report says somebody edited since this campaign set it. Asked of the report
  // here, after the claim and this run's own plan, so it is the edit as the revert finds it.
  const keptEdits = options.keepEdited && wholeRevert ? await editedVariants(shopId, campaignId) : [];
  // And a resumed revert keeps what the revert it continues kept (#1157), whichever way it
  // kept them: the Revert tab's "Leave as it is", a held sale's scheduled end (#784), Flow's
  // End campaign (#794). Resume posts no list and was planned as a fresh revert, so it wrote
  // the campaign-free price over every one. Read back from that revert's ledger, reasons and
  // all, and ledgered again below, so a resume of this run keeps them too.
  const keptBefore = wholeRevert && options.resume ? await editsKeptByResumed(campaignId) : new Map<string, string>();
  const leaveAlone = new Set([...(options.skipVariantGids ?? []), ...keptEdits, ...keptBefore.keys()]);

  let writable = outcome.rows.filter(
    (row) => row.status !== "skipped" && !leaveAlone.has(row.ref.variantGid),
  );

  // Planned, then deliberately not written. Kept separate from `writable` so nothing
  // downstream can accidentally execute them, and still ledgered below.
  const spared =
    leaveAlone.size === 0
      ? []
      : outcome.rows.filter(
          (row) => row.status !== "skipped" && leaveAlone.has(row.ref.variantGid),
        );

  // Resuming: drop rows a previous attempt already verified. The resolver would reach
  // the same answer for them anyway, but re-sending costs rate limit and, worse, the
  // mirror could be stale enough to make an already-correct row look like it needs
  // rewriting.
  let resumedFrom: { verified: number; quarantined: number } | null = null;
  // The run being resumed, whose market rows that landed a resume leaves alone too: its
  // markets now cover every in-scope variant (#841), and re-sending the ones already
  // priced would cost a resume of a large campaign a write per variant per market.
  let marketsLandedIn: string | undefined;
  if (options.resume && !options.revert) {
    const resumed = await runToResume(campaignId);
    if (resumed?.kind === kind) marketsLandedIn = resumed.id;
    const prior = await priorLedger(campaignId, kind);
    if (prior.length > 0) {
      const plan = planResume(writable, prior);
      writable = plan.todo;
      resumedFrom = { verified: plan.alreadyVerified, quarantined: plan.quarantined };
    }
  }

  // What the tag and market steps cover: every row this run writes, and the variants a
  // settled bulk operation landed (#832). The run that sent those died before tagging them
  // or pricing their markets, and this one plans them as no change -- the mirror already
  // has their price -- so they are carried by id.
  const followers = [
    ...new Set([
      ...writable.map((row) => row.ref.variantGid),
      ...[...settledLanded].filter((gid) => !leaveAlone.has(gid)),
    ]),
  ];
  // What the market and tag steps cover: every in-scope variant the plan did not set
  // aside, the ones already at their base price included. Each market makes its own no-op
  // check (#841), and tagging claims what this campaign tagged before rather than adding
  // it again (#926). Inheriting the base surface's write set meant a market or a tag
  // skipped, failed or added later was never put right once the base price was.
  const marketVariants = [
    ...new Set([
      ...(outcome.kind === "ok" ? marketScope(campaignId, outcome.rows, outcome.unchanged) : []).filter(
        (gid) => !leaveAlone.has(gid),
      ),
      ...followers,
    ]),
  ];

  // Written in chunks, a turn on the large lane each, when the caller can give the run back to
  // its lane between them and it is large enough to want it (#809, D34): this call plans and
  // ledgers, and `continueChunkedRun` writes. The path is the one the executor would choose for
  // the whole run, chosen once, so every chunk is a bulk operation however few rows it has.
  const writeCount = writable.filter((row) => row.intendedPrice).length;
  const chunkRows =
    options.turns && !options.variantGids
      ? chunkRowsFor(writeCount, options.forcePath ?? selectWritePath(writeCount).path, RUN_CHUNK_ROWS)
      : null;

  // One run per (campaign, occurrence, kind), enforced by a unique index. Two workers
  // ticking the same campaign at once -- which is exactly what happens in the window
  // after a Redis restart drops the leader lock -- have one of them lose this race,
  // and losing it must not look like a failure. The loser stands down; the winner
  // applies. Letting the constraint violation escape instead surfaced a raw Prisma
  // error to the merchant, and a scheduler tick that reports a crash where it should
  // report "already running" is a scheduler nobody can read.
  const occurrenceKey = options.occurrenceKey ?? `${kind}-${Date.now()}`;

  let run: { id: string };
  try {
    run = options.runId
      ? await startQueuedRun(options.runId, outcome.counts.planned)
      : await prisma.campaignRun.create({
          data: {
            shopId,
            campaignId,
            kind,
            status: "EXECUTING",
            occurrenceKey,
            plannedRows: outcome.counts.planned,
            startedAt: new Date(),
            heartbeatAt: new Date(),
          },
          select: { id: true },
        });

    // The one id that cannot be bound at the boundary: it does not exist until this row
    // does. Everything after this point — planning results, execution, verification,
    // tags, markets — logs with the run it belongs to.
    addLogContext({ runId: run.id });
    started.runId = run.id;
  } catch (error) {
    if (!isOccurrenceTaken(error)) throw error;

    const existing = await prisma.campaignRun.findFirst({
      where: { campaignId, occurrenceKey, kind },
      select: { id: true, status: true },
    });


    // Standing down is right only when the other run is still going. Deferring to a run
    // that already finished left the campaign claimed -- REVERTING or APPLYING -- with
    // nothing behind it, forever (#700). Thrown, so the claim is released like any other
    // failure before the run existed.
    if (existing && FINISHED_RUN.has(existing.status)) {
      throw new OccurrenceFinishedError(occurrenceKey, existing.id, existing.status);
    }

    // A whole-campaign run is live -- this occurrence's, or another one the database refused
    // a second of (#793). Two presses of Apply, a second tab, a Flow resend: whichever got
    // past the check above at the same moment, only one run row can exist, and this one
    // stands down to it having written nothing. Presses in the same millisecond share an
    // occurrence; the rest collide on `campaign_runs_one_live_run`. Either way, one message.
    if (!options.variantGids) {
      const live = await liveFullRun(campaignId);
      if (live) return standDown(campaignId, live, options, outcome.counts.planned);
    }

    return {
      runId: existing?.id ?? "",
      planned: outcome.counts.planned,
      verified: 0,
      failed: 0,
      unverified: 0,
      clean: true,
      deferredTo: existing?.id,
      messages: [
        `This campaign is already being ${options.revert ? "reverted" : "applied"} by ` +
          `another worker. Nothing was written twice; watch the run already in progress.`,
      ],
    };
  }

  // The scheduler's retried claim, now that this run holds its occurrence (#829).
  if (options.claimUnrecorded && options.claimedFrom && !options.variantGids) {
    await recordClaim(
      shopId,
      campaignId,
      { from: options.claimedFrom, to: options.revert ? "REVERTING" : "APPLYING", reason: options.claimUnrecorded },
      { actor: options.actor, runId: run.id },
    );
  }

  // The other half of the check above (#763): this run's row exists, so a full run
  // claiming the campaign from now on will see it. One that claimed first is seen here.
  if (options.variantGids) {
    const holder = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (holder && CLAIMED.has(holder.status)) {
      await prisma.campaignRun.update({
        where: { id: run.id },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
      const message =
        `This campaign is being ${holder.status === "REVERTING" ? "reverted" : "applied"} right now, ` +
        "so nothing was written for this variant. Try again once that has finished.";
      return {
        runId: run.id,
        planned: 0,
        verified: 0,
        failed: 0,
        unverified: 0,
        clean: true,
        messages: [message],
        refused: message,
        transient: true,
      };
    }
  }

  await writeLedgerRows(run.id, shopId, writable);
  // A chunked run's turns rebuild each row from its ledger alone (`plannedRowOf`), so a clamped
  // row says why now, as a bulk run's rows say it when Shopify accepts them (#792).
  if (chunkRows) await ledgerClampReasons(run.id, shopId, writable);
  await writeSparedRows(run.id, shopId, spared, options.skipReason, keptBefore);

  // Record intents before writing: every price we write produces a products/update
  // webhook moments later, and without this the drift detector would flag our own
  // writes and bury the merchant in false events. A chunked run records each chunk's as it
  // writes it (#809): an intent lasts fifteen minutes, and its later chunks are written later.
  if (!chunkRows) await recordWriteIntents(shopId, intentsOf(writable));

  // A revert's takeover reaches past what it writes: the variants an earlier attempt put
  // back, which plan as unchanged (#926). Their products are needed for the winner's tags.
  const handedBack =
    options.revert && outcome.kind === "ok"
      ? outcome.unchanged.filter((row) => !leaveAlone.has(row.ref.variantGid))
      : [];
  // Read by the turn that needs them, for a chunked run: each its chunk's, the last its tags'.
  const products = chunkRows
    ? new Map<string, string>()
    : await productMapFor(shopId, [...new Set([...marketVariants, ...handedBack.map((row) => row.ref.variantGid)])]);

  // Honour the planner's path choice. A 1,600-row campaign executed synchronously
  // would take roughly one variant every two seconds against a standard shop's
  // rate limit; the bulk path costs no rate-limit budget at all.
  // `writable`, not `outcome.rows`: skipped rows were never going to be written, and
  // on a resume this is the filtered set. Passing the unfiltered plan here would make
  // the resume silently re-send every row it had just decided to leave alone.
  const messagesBeforeExecution: string[] = [];
  const refusedMarkets: string[] = [];

  // Market baselines before any surface is written, never after.
  //
  // This used to happen down with the market writes, which meant a market's "untouched"
  // price was read from Shopify *after* the base price had been changed — so the first
  // campaign to touch a market recorded its own sale price as that market's normal one.
  // A -20% campaign on a -10% EUR market stored €69.84 where €87.30 was the truth, and
  // every later run, revert and strike-through inherited it.
  //
  // Nothing is written here; it only records what the markets look like now, which is
  // exactly the moment that is about to stop being observable.
  if (!options.revert) {
    const baselines = await captureMarketBaselinesFirst(
      shopId,
      campaignId,
      // The run's whole scope, not only the rows its base surface writes: a variant already
      // at its base price may still need its markets priced (#763, #841).
      options.variantGids ?? marketVariants,
      client,
    );
    messagesBeforeExecution.push(...baselines.messages);
    // Carried to the market step so a market refused here is not quietly priced there.
    refusedMarkets.push(...baselines.refused);
  }

  // One throttled heartbeat for every phase that writes: prices, then tags, then markets.
  // Prices alone used to stamp it, so a run tagging a few thousand products one call at a
  // time went quiet for minutes and the reaper took it for dead while it was still
  // writing -- Partial, with a Resume button that would have started a second writer (#791).
  //
  // A whole-campaign apply also watches for its own end on that beat (#829): still writing
  // when its revert was due, it tells the merchant the sale is ending late, once. Asked once
  // before writing too, for a revert moment that passed while this run was being planned.
  const pulse = heartbeat(run.id);
  const lateWatch = !options.revert && !options.variantGids ? endingLateWatch(shopId, campaignId, campaignRecord.schedule) : null;
  // The prices' executor passes how far it has got, which the stamp keeps (#820).
  const beat = lateWatch
    ? async (written?: number, writable?: number) => {
        await pulse(written, writable);
        await lateWatch();
      }
    : pulse;
  await lateWatch?.();

  // What the rest of the run needs from this plan -- its tags, markets, counts and end --
  // whether its prices are written now or a chunk a turn (#809, D34).
  const tail: RunTail = {
    runId: run.id,
    kind,
    campaignName,
    resolvable,
    breach,
    wholeRevert,
    takeover: [...writable, ...handedBack],
    marketVariants,
    products,
    refusedMarkets,
    marketsLandedIn,
    unplanned: unplanned.length,
    before: messagesBeforeExecution,
    counts: {
      planned: outcome.counts.planned,
      skipped: outcome.counts.skipped,
      clamped: outcome.counts.clamped,
      noop: outcome.counts.noop,
    },
    skips: describeSkips(outcome.rows),
    unchanged:
      options.variantGids && outcome.kind === "ok"
        ? outcome.unchanged.filter(({ ref }) => ref.priceListGid === "").map(({ ref }) => ref.variantGid)
        : [],
    settledNote,
    kept: keptBefore.size,
    spared: spared.length,
    resumedFrom,
    startedAt,
  };

  // Large enough to write in chunks (#809, D34): planned and ledgered, and not a price written in
  // this turn. Its first chunk is the next turn's, behind whoever waits on the lane.
  if (chunkRows) {
    return beginChunks(run.id, tail, {
      chunkRows,
      writeCount,
      options,
      releaseTo: started.releaseTo ?? stateBefore,
    });
  }

  // From here a failure may have changed the storefront (#802).
  started.writing = true;

  const result = await executeRows(writable, {
    client,
    shopId,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: options.verifySampleRate ?? 1,
    forcePath: options.forcePath,
    bulkWaitMs: options.bulkWaitMs,
    onProgress: beat,
    // On the run row, where an estimate of how long the next one takes reads it from (#1055).
    onPath: async (path) => {
      await retryTransient("run.write-path", () =>
        prisma.campaignRun.update({ where: { id: run.id }, data: { writePath: path === "bulk" ? "BULK" : "SYNC" } }),
      );
    },
    // A bulk operation, once accepted, applies its prices whatever happens to this
    // process. Its rows say "sent to Shopify" from that moment, in the same step that
    // records which operation holds them (#832). Until now they stayed Pending -- "Nothing
    // has been written" -- for over an hour while Shopify applied 100,139 prices.
    //
    // One transaction, retried whole on a transient error (#810): the record and the rows
    // it holds move together, and a P2024 or P2034 means none of it committed. Its clamp
    // reasons go in `RUN_CHUNK` batches, never one list per reason.
    onSubmitted: async (operation) => {
      await retryTransient("run.bulk-submitted", () => prisma.$transaction([
        recordOperation(shopId, run.id, operation),
        prisma.variantChange.updateMany({
          where: { runId: run.id, shopId, status: "PENDING", surfaceKind: "BASE", priceListGid: "" },
          data: { status: "WRITING" },
        }),
        // Why a clamped row's price is not the rule's, said now rather than with the
        // results. A run that dies before they arrive leaves the next run to settle these
        // rows from the result file, and the ledger is all it has to tell clamped from
        // verified by (#792).
        ...CLAMP_REASONS.flatMap(([reason, text]) =>
          chunk(
            writable
              .filter((row) => row.status === "clamped" && (row.reason ?? "below-floor") === reason)
              .map((row) => row.ref.variantGid),
            RUN_CHUNK,
          ).map((batch) =>
            prisma.variantChange.updateMany({
              where: { runId: run.id, shopId, variantGid: { in: batch } },
              data: { failureReason: text },
            }),
          ),
        ),
      ]));
    },
    onPoll: recordPoll,
    // Shopify is running as many bulk mutations for this app in the shop as it allows, and
    // refused this one (#1054). The run waits for a turn still holding its occurrence (rule
    // 2), and says behind whom in the campaign's history and on its Status card.
    onBulkWait: () => noteBulkWait(shopId, campaignId, { id: run.id, actor: options.actor, prices: writable.length }),
  });

  // Every price has been sent and answered. What is left is reading them back, and the tags
  // and market prices that follow them: the page says Verifying from here (#808), where the
  // count it showed as Writing N of M has nothing more to say.
  await prisma.campaignRun.updateMany({ where: { id: run.id, status: "EXECUTING" }, data: { status: "VERIFYING" } }).catch(() => {});

  const failures = await recordResults(run.id, shopId, result.rows);
  return finishRun(
    shopId,
    campaignId,
    client,
    options,
    tail,
    {
      verified: result.verified,
      failed: result.failed,
      unverified: result.unverified,
      clean: result.clean,
      verifiedGids: verifiedVariants(result.rows),
      failures,
    },
    beat,
  );
}

/**
 * What a run's prices left for the rest of it (#809, D34): how many were written and read back,
 * which, and why any failed. From the executor's rows for a run written in one call, and from
 * the ledger for a chunked run, whose rows were written over many turns.
 */
interface Written {
  verified: number;
  failed: number;
  unverified: number;
  clean: boolean;
  /** Base-price variants written and read back, for the drift queue (#755). */
  verifiedGids: string[];
  /** Why rows failed, in Shopify's words and ours, in the order they did. */
  failures: string[];
}

type Breach = Awaited<ReturnType<typeof loadCampaignContext>>["breach"];

/**
 * Everything the rest of a run needs from its plan: its tags, its market prices, its counts and
 * its end. Built from the plan by a run written in one call, and from its carry by a chunked
 * run's last turn (`ChunkCarry`), so the two end through the same lines (`finishRun`).
 */
interface RunTail {
  runId: string;
  kind: "APPLY" | "REVERT";
  campaignName: string;
  /** Every campaign the run resolves against, for the market step. */
  resolvable: ResolvableCampaign[];
  breach: Breach;
  wholeRevert: boolean;
  /** Whom each variant goes to after a revert, for the takeover tags (#687, #926). */
  takeover: readonly WinnerRow[];
  marketVariants: string[];
  products: Map<string, string>;
  refusedMarkets: string[];
  marketsLandedIn?: string;
  /** Prices a whole revert had no baseline to take back (#828). */
  unplanned: number;
  /** Said before any price was written. */
  before: string[];
  counts: ChunkCarry["counts"];
  skips: string[];
  /** For a run over named variants: those already at the campaign's price (#1042). */
  unchanged: string[];
  settledNote: string | null;
  kept: number;
  spared: number;
  resumedFrom: ChunkCarry["resumedFrom"];
  startedAt: number;
}

/**
 * The rest of a run once its prices are written and recorded: tags, then market prices, then the
 * mirror, the run's counts and the campaign's state, the drift queue, the email and Flow. The
 * lines a run has always ended with, shared since #809 by a run written in one call and a chunked
 * run's last turn (D34), so a run reads the same however its prices were written.
 */
async function finishRun(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions,
  tail: RunTail,
  written: Written,
  beat: () => Promise<void>,
): Promise<RunOutcome> {
  const messages = [...tail.before, ...written.failures];
  let clean = written.clean;

  // Prices this campaign wrote that the revert had no baseline to take them back to. The
  // revert is not over while they stand, so it does not say it is (#828).
  if (tail.unplanned > 0) {
    clean = false;
    messages.push(
      `${tail.unplanned} variant${tail.unplanned === 1 ? "" : "s"} this campaign priced ${tail.unplanned === 1 ? "has" : "have"} no ` +
        "baseline to go back to, so they still show the campaign's price. Capture their baselines on Prices → Baselines, " +
        "then Resume to finish the revert.",
    );
  }

  // Tags after prices, deliberately. A badge on a product still showing full price is
  // worse than a price change nobody has badged yet, so the storefront never claims a
  // sale that has not landed.
  // A revert hands its variants to whoever prices them next, those an earlier attempt
  // already put back included: they plan as unchanged, and their new winner's tags were
  // never applied if that attempt died before its tag step (#926).
  const tagOutcome = await syncTags(shopId, campaignId, tail.runId, tail.takeover, tail.marketVariants, tail.products, client, options, beat);
  if (tagOutcome) messages.push(...tagOutcome.messages);

  // Markets, after the base surface. A campaign that only ever touched the base price
  // does nothing for a merchant selling into four markets — their EUR and JPY customers
  // see the old price for the whole sale. A failure here does not stop the run -- the base
  // prices already landed -- but it does leave it unfinished: see below (#1001).
  let marketsStopped = false;
  // Market-wide percentages a whole revert could not put back, which no row counts (#706).
  let percentagesLeft = 0;
  try {
    const markets = options.variantGids
      ? // A scoped run prices its own variants' markets and nobody else's (#763). It used
        // to skip markets altogether, so a variant taken out of a sale went back to full
        // price at home and stayed discounted in every market until the whole campaign
        // ended. Recomputed, not restored: a revert plans without this campaign, as the
        // base surface does. Per product only -- a market-wide percentage moves the whole
        // list, which is the one thing a run over one variant must never do.
        await applyMarketSurfaces(
          shopId,
          campaignId,
          tail.runId,
          options.revert ? tail.resolvable.filter((campaign) => campaign.id !== campaignId) : tail.resolvable,
          options.variantGids,
          client,
          tail.refusedMarkets,
          // A variant taken out of a sale follows a percentage list again, rather than being
          // pinned at the price the list derives today (#1002). A market it stops says what to
          // do by the campaign's policy (#1161), except on a revert, which plans without it.
          {
            perProductOnly: true,
            onProgress: beat,
            letFollow: options.revert === true,
            ...(options.revert ? {} : { breach: tail.breach }),
          },
        )
      : options.revert
        ? await revertMarketSurfaces(shopId, campaignId, client, beat, {
            runId: tail.runId,
            campaigns: tail.resolvable.filter((campaign) => campaign.id !== campaignId),
          })
        : await applyMarketSurfaces(
            shopId,
            campaignId,
            tail.runId,
            tail.resolvable,
            tail.marketVariants,
            client,
            tail.refusedMarkets,
            // As this run keeps it, not as it was before the claim (#1161): a market is planned
            // once the base prices are up, so whatever stops one, the campaign has started.
            { onProgress: beat, alreadyLandedIn: tail.marketsLandedIn, breach: tail.breach },
          );

    for (const market of markets) {
      if (market.failed > 0) {
        messages.push(
          `${market.name} (${market.currency}): ${countOf(market.failed, "price")} did not apply.`,
        );
      }
      // How a market written product by product was written, and why, with the reason the
      // Markets card gave before Apply (#1115). A market repriced market-wide says so, and so
      // does one the base price carried, where nothing was written (no chunks); this one
      // said nothing unless a price failed.
      if (market.path === "per-product" && market.pathReason && market.chunks > 0) {
        messages.push(`${market.name}: priced product by product rather than with one market-wide change, because ${market.pathReason}.`);
      }
      messages.push(...market.messages);
      percentagesLeft += market.percentagesLeft ?? 0;
    }
  } catch (error) {
    marketsStopped = true;
    messages.push(
      `Base prices were ${options.revert ? "put back" : "applied"}, but market prices did not finish: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // A market price is a price a shopper pays, so an apply is clean only when its market
  // rows are as well (rule 5, #1001). Only the base rows used to count: an apply whose euro
  // prices all failed ended Completed, the campaign read Active -- "every row was read back
  // and verified" -- and EUR shoppers paid full price with nothing offering to fix it. Now it
  // is Partial, and Resume retries the market rows that did not land and nothing else.
  //
  // A whole revert's too (#706). Its deletes settle the apply's rows rather than its own, so
  // none it failed was counted, and the campaign read Completed -- "prices are back" -- with
  // Europe still on sale and nothing offering to finish it. A delete Shopify refuses is now a
  // FAILED row of the revert's, and a market-wide percentage it could not put back is counted
  // beside them, so the revert is Partial and Resume sends what is outstanding again.
  const markets = await outstandingMarketRows(tail.runId);
  if (marketsStopped) clean = false;
  if (markets.failed + markets.unverified + percentagesLeft > 0) clean = false;
  // Every surface, for what the merchant reads: "Partial · 0 failed" over three euro prices
  // that failed reads as nothing being wrong. The metrics below stay the base surface's;
  // the market writer reports its own.
  const failedRows = written.failed + markets.failed + percentagesLeft;
  const unverifiedRows = written.unverified + markets.unverified;
  // And its verified prices, where the market prices are all it writes (#1111). A campaign
  // for Europe alone that verified every euro price said "apply finished: 0 verified" -- in
  // its history, its run row, its outcome and its email. A campaign that also prices the base
  // price still counts that one: its "N verified" has always been the store prices. Not a
  // whole revert's, whose market rows are only the few it wrote back: what it deleted settles
  // the apply's rows, and its count stays the store prices it put back.
  const marketsOnly = tail.resolvable.some((campaign) => campaign.id === campaignId && campaign.marketsOnly);
  const verifiedRows = written.verified + (marketsOnly && !tail.wholeRevert ? markets.verified : 0);

  // The mirror, before anything says this run is over (#906). It was refreshed row by row
  // -- two queries a variant, 204,000 for a 102,132-variant apply -- *after* the campaign
  // read Active, so for minutes the campaign looked finished over a mirror still holding
  // pre-run prices. A revert started in that window planned 3,831 variants as already at
  // baseline, skipped them, and reported clean with the sale live; the late refresh then
  // overwrote 2,514 rows the revert had just restored. Now it is a handful of statements
  // from the ledger, done before the run row or the campaign says "finished".
  await settleMirror(tail.runId);

  // Retried like the ledger (#810): every price has landed and been recorded by now, and a
  // pool timeout on the one statement saying so must not turn a clean run into a Partial.
  await retryTransient("run.finish", () =>
    prisma.campaignRun.update({
      where: { id: tail.runId },
      data: {
        status: clean ? "COMPLETED" : "PARTIAL",
        verifiedRows,
        failedRows,
        skippedRows: tail.counts.skipped,
        finishedAt: new Date(),
      },
    }),
  );

  // A run over a named handful of variants says nothing about the campaign as a
  // whole. Reverting one variant out of a four-thousand-variant sale must not mark
  // the sale COMPLETED -- it is still running, for everything else. The ledger records
  // what happened to those rows; the campaign's own state is left alone.
  if (options.variantGids) {
    await resolveOverwrittenDrift(shopId, tail.runId, written.verifiedGids, tail.kind, options.actor);

  // The headline panels, from the one place that knows the answer. Counts and durations
  // only — the ledger holds what actually changed.
  metric("run.duration_ms", Date.now() - tail.startedAt, { shopId, campaignId, kind: tail.kind });
  metric("run.verified_clean_rate", clean ? 1 : 0, { shopId, campaignId, kind: tail.kind });
  metric("run.rows", written.verified, { shopId, campaignId, outcome: "verified" });
  if (written.failed > 0) metric("run.rows", written.failed, { shopId, campaignId, outcome: "failed" });
  if (written.unverified > 0) {
    metric("run.rows", written.unverified, { shopId, campaignId, outcome: "unverified" });
  }
    const unchanged = tail.unchanged;
    return {
      ...scopedOutcome(tail.runId, tail.counts.planned, { verified: verifiedRows, failed: failedRows, unverified: unverifiedRows, clean }, messages),
      unchanged,
    };
  }

  // Through the state machine, not a direct write: it enforces which moves are legal
  // and records how the campaign got here. A run that finishes late must not clobber a
  // newer state, which a bare update would happily do.
  const finalState = options.revert
    ? clean
      ? "COMPLETED"
      : "PARTIAL"
    : clean
      ? "ACTIVE"
      : "PARTIAL";

  await transitionCampaign(shopId, campaignId, finalState, {
    reason:
      `${options.revert ? "revert" : "apply"} finished: ${verifiedRows} verified, ${failedRows} failed` +
      (tail.settledNote ? `. ${tail.settledNote}` : "") +
      // Nobody ticked these (#794), nor on a resume (#1157), so the history is where the
      // merchant reads that they stayed.
      ((options.keepEdited || tail.kept > 0) && tail.spared > 0 ? `. ${editsLeft(tail.spared)}` : ""),
    runId: tail.runId,
    actor: options.actor,
  });

  // A held campaign can still be applied; whatever this run wrote over an edit made
  // outside Anchor now stands, and the drift queue must stop asking about it (#755).
  await resolveOverwrittenDrift(shopId, tail.runId, written.verifiedGids, tail.kind, options.actor);

  // The headline panels, from the one place that knows the answer. Counts and durations
  // only — the ledger holds what actually changed.
  metric("run.duration_ms", Date.now() - tail.startedAt, { shopId, campaignId, kind: tail.kind });
  metric("run.verified_clean_rate", clean ? 1 : 0, { shopId, campaignId, kind: tail.kind });
  metric("run.rows", written.verified, { shopId, campaignId, outcome: "verified" });
  if (written.failed > 0) metric("run.rows", written.failed, { shopId, campaignId, outcome: "failed" });
  if (written.unverified > 0) {
    metric("run.rows", written.unverified, { shopId, campaignId, outcome: "unverified" });
  }

  // Best-effort, and deliberately last. A campaign runs for hours; the merchant has to
  // be able to close the tab and still learn the outcome. Nothing about a mail
  // provider is allowed to change what happened to their prices, so this never throws
  // and never blocks the outcome being returned.
  void notify(shopId, {
    campaignId,
    // A revert that left prices on sale is a partial run, not "has been reverted" (#710).
    kind: clean ? (options.revert ? "revert-completed" : "run-completed") : "run-partial",
    revert: options.revert === true,
    campaignName: tail.campaignName ?? "Your campaign",
    counts: {
      verified: verifiedRows,
      failed: failedRows,
      unverified: unverifiedRows,
      skipped: tail.counts.skipped,
      clamped: tail.counts.clamped,
    },
    reasons: messages.slice(0, 5),
  }, { runId: tail.runId });

  // Told after the fact, never awaited for correctness. A campaign must not fail because
  // an automation could not be notified about it.
  await fireCampaignTrigger(shopId, campaignId, tail.campaignName, options, tail.counts.planned, { verified: written.verified, clean });

  return {
    runId: tail.runId,
    planned: tail.counts.planned,
    verified: verifiedRows,
    failed: failedRows,
    unverified: unverifiedRows,
    clean,
    ...(options.keepEdited ? { keptEdits: tail.spared } : {}),
    messages: [
      ...(tail.settledNote ? [tail.settledNote] : []),
      // What the resume left alone, under "Resumed" (#1157): the banner it was pressed under
      // said it would.
      ...(tail.kept > 0 && tail.spared > 0 ? [editsLeft(tail.spared)] : []),
      // Lead with what was skipped. "Applied 3 variants" after a 1,500-row campaign
      // looks like a catastrophe until you know the other 1,497 were already correct
      // and deliberately left alone.
      //
      // Two independent things skip work, and the merchant does not care which: the
      // planner drops rows already showing the target price, and the resume drops rows
      // the ledger says were verified. Reporting only the latter said "0 rows were
      // already verified" straight after a run that had verified two of them.
      ...(tail.resumedFrom && tail.resumedFrom.verified + tail.counts.noop > 0
        ? [
            `Resumed: ${tail.resumedFrom.verified + tail.counts.noop} rows were already correct and left untouched` +
              (tail.resumedFrom.quarantined > 0
                ? `, ${tail.resumedFrom.quarantined} quarantined after repeated failures`
                : "") +
              ".",
          ]
        : []),
      // Rows the plan decided not to write, grouped by why. Previously only *resume*
      // skips were reported, so a campaign that skipped four hundred products for a
      // nameable reason — no cost, below a floor, not in the imported file — handed the
      // merchant a smaller number than they expected and no explanation for it. The
      // count was in the database; it was just never said out loud.
      ...tail.skips,
      ...messages.slice(0, 5),
    ],
  };
}


/** The write intents for rows about to be written: their price, and their compare-at when they decide it. */
function intentsOf(rows: readonly PlannedRow[]) {
  return rows.map((row) => ({
    variantGid: row.ref.variantGid,
    price: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
    // A row that leaves compare-at alone did not decide it, so its echo is matched on
    // price alone (#731). A row that clears it intends `null`, and says so.
    compareAt: !row.intendedCompareAtSet
      ? ("leave" as const)
      : row.intendedCompareAt
        ? BigInt(row.intendedCompareAt.amount)
        : null,
  }));
}

/** The record of a bulk operation Shopify accepted for a run (#832), as a statement for its transaction. */
function recordOperation(shopId: string, runId: string, operation: BulkOperationState) {
  return prisma.bulkOperationRecord.upsert({
    where: { shopifyGid: operation.id },
    create: { shopId, runId, shopifyGid: operation.id, kind: "MUTATION", ...bulkProgress(operation) },
    update: { shopId, runId, kind: "MUTATION", submittedAt: new Date(), finishedAt: null, ...bulkProgress(operation) },
  });
}

/** Each poll of a bulk operation, and its final state, on its record. */
async function recordPoll(operation: BulkOperationState): Promise<void> {
  await retryTransient("run.bulk-poll", () =>
    prisma.bulkOperationRecord.updateMany({
      where: { shopifyGid: operation.id },
      data: { ...bulkProgress(operation), lastPolledAt: new Date() },
    }),
  );
}

/**
 * A chunked run's clamped rows say why with its ledger (#792, D34): its turns rebuild each row
 * from the ledger alone, and this is how one tells a clamped row from one priced by the rule.
 * In `RUN_CHUNK` batches, each retried (#810).
 */
async function ledgerClampReasons(runId: string, shopId: string, rows: readonly PlannedRow[]): Promise<void> {
  for (const [reason, text] of CLAMP_REASONS) {
    const gids = rows
      .filter((row) => row.status === "clamped" && (row.reason ?? "below-floor") === reason)
      .map((row) => row.ref.variantGid);
    if (gids.length === 0) continue;
    await inRunChunks("ledger.base.clamp", gids, (batch) =>
      prisma.variantChange.updateMany({
        where: { runId, shopId, surfaceKind: "BASE", priceListGid: "", variantGid: { in: batch } },
        data: { failureReason: text },
      }),
    );
  }
}

/**
 * Ends a chunked run's first turn (#809, D34): every price planned and ledgered, none written.
 * Keeps what its last turn needs beside the run (`ChunkCarry`), stamps how many prices it writes
 * so the page counts the run's and not a chunk's, and marks it waiting for its next turn, which
 * writes its first chunk. The run stays EXECUTING, the campaign's writer, until its last turn.
 */
async function beginChunks(
  runId: string,
  tail: RunTail,
  how: { chunkRows: number; writeCount: number; options: RunOptions; releaseTo: CampaignState | undefined },
): Promise<RunOutcome> {
  const { options } = how;
  const carry: ChunkCarry = {
    actor: options.actor,
    revert: options.revert === true,
    resume: options.resume === true,
    keepEdited: options.keepEdited === true,
    queued: options.queued === true,
    ...(options.claimedFrom ? { claimedFrom: options.claimedFrom } : {}),
    ...(how.releaseTo ? { releaseTo: how.releaseTo } : {}),
    wholeRevert: tail.wholeRevert,
    startedAt: tail.startedAt,
    counts: tail.counts,
    skips: tail.skips,
    resumedFrom: tail.resumedFrom,
    settledNote: tail.settledNote,
    kept: tail.kept,
    spared: tail.spared,
    unplanned: tail.unplanned,
    before: tail.before,
    refusedMarkets: tail.refusedMarkets,
    ...(tail.marketsLandedIn ? { marketsLandedIn: tail.marketsLandedIn } : {}),
    marketVariants: tail.marketVariants,
    // Only a revert's tags read whom each variant goes to: an apply tags its own scope.
    winners: options.revert
      ? tail.takeover.flatMap((row): Array<[string, string]> => (row.campaignId ? [[row.ref.variantGid, row.campaignId]] : []))
      : [],
    failures: [],
  };
  const now = new Date();
  await retryTransient("run.chunks", () =>
    prisma.$transaction([
      prisma.runChunk.create({
        data: { runId, size: how.chunkRows, turns: 1, waitingSince: now, carry: carry as unknown as Prisma.InputJsonObject },
      }),
      // The run's count from here, for "Writing N of M" (#820): every chunk's prices, not one's.
      prisma.campaignRun.update({
        where: { id: runId },
        data: { writePath: "BULK", writtenRows: 0, writableRows: how.writeCount, heartbeatAt: now },
      }),
    ]),
  );
  const parts = Math.ceil(how.writeCount / how.chunkRows);
  return {
    runId,
    planned: tail.counts.planned,
    verified: 0,
    failed: 0,
    unverified: 0,
    clean: false,
    continues: true,
    messages: [
      `Planned ${countOf(how.writeCount, "price")}: the background worker writes them in ${formatCount(parts)} parts of ` +
        `${formatCount(how.chunkRows)}, between other stores' runs.`,
    ],
  };
}

/** How a chunked run's turn ended (#809, D34), for the job that took it. */
export type ChunkTurn =
  /** It wrote a chunk, or found Shopify still on the last one, and the run goes on. */
  | { kind: "continues"; runId: string; campaignId: string; delayMs?: number }
  /** Its last turn: the run is over, and `outcome` is what its one job would have answered. */
  | { kind: "finished"; runId: string; campaignId: string; revert: boolean; outcome: RunOutcome }
  /** Another process is in the run's turn: a job delivered twice, or rung beside the turn's own. */
  | { kind: "elsewhere" }
  /** The run is not one this can write: finished, reclaimed, or never chunked. */
  | { kind: "over" };

/** A run in one of these is still its campaign's writer. */
const LIVE_RUN_STATES: ReadonlySet<string> = new Set(["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"]);

/**
 * One turn of a chunked run (#809, D34): takes the run's turn, writes its next chunk, and ends
 * the turn -- or, when nothing is left, ends the run.
 *
 * The turn is taken by one conditional update on the run's chunk row, so a job delivered twice,
 * or rung beside its own, writes nothing. Then:
 *
 * - **A bulk operation a turn before this one sent and died waiting on** is asked of Shopify
 *   first, and its rows settled from its result file (#832). Still running, the turn ends and the
 *   next asks again; nothing is sent beside it.
 * - **The next chunk** is the next `size` PENDING rows of the run's ledger, written exactly as the
 *   plan wrote them (`plannedRowOf`): their write intents, one bulk operation, its read-back and
 *   its results recorded, the run's heartbeat and count stamped as it goes. Nothing is planned
 *   again, and a row a turn has written is never in a chunk again.
 * - **Rows left**, the turn ends: the run waits for its next turn, holding its shop.
 * - **None left**, the run ends as its one job did (`finishRun`): tags, markets, the mirror, its
 *   counts from the ledger, the campaign's state, the drift queue, the email and Flow.
 *
 * A turn that throws ends the run as a run written in one call ends when it throws
 * (`endFailedRun`): Partial when prices may have changed, its rows where the ledger has them, and
 * Resume to finish it.
 */
export async function continueChunkedRun(shopId: string, runId: string, client: AdminClient | null): Promise<ChunkTurn> {
  const taken = await prisma.runChunk.updateMany({
    where: { runId, waitingSince: { not: null }, run: { is: { shopId, status: "EXECUTING" } } },
    data: { waitingSince: null, turns: { increment: 1 } },
  });
  if (taken.count !== 1) {
    const live = await prisma.campaignRun.findFirst({
      where: { id: runId, shopId, chunk: { isNot: null } },
      select: { status: true },
    });
    return live && LIVE_RUN_STATES.has(live.status) ? { kind: "elsewhere" } : { kind: "over" };
  }

  const [run, held] = await Promise.all([
    prisma.campaignRun.findUniqueOrThrow({ where: { id: runId }, select: { campaignId: true, kind: true, writableRows: true } }),
    prisma.runChunk.findUniqueOrThrow({ where: { runId }, select: { size: true, carry: true } }),
  ]);
  const { campaignId } = run;
  const carry = held.carry as unknown as ChunkCarry;
  // The options the run was planned with, as far as the rest of it reads them.
  const options: RunOptions = {
    actor: carry.actor,
    revert: carry.revert,
    resume: carry.resume,
    queued: carry.queued,
    ...(carry.keepEdited ? { keepEdited: true } : {}),
    ...(carry.claimedFrom ? { claimedFrom: carry.claimedFrom as CampaignState } : {}),
  };

  return withLogContext({ shopId, campaignId, runId }, async () => {
    // Alive from the moment the turn is taken: the reaper judges a turn by this, as it does a run.
    const pulse = heartbeat(runId);
    await pulse();
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { schedule: true } });
    const lateWatch = carry.revert ? null : endingLateWatch(shopId, campaignId, campaign?.schedule);
    const beat = lateWatch
      ? async (written?: number, writable?: number) => {
          await pulse(written, writable);
          await lateWatch();
        }
      : pulse;

    // Whether a price may have changed: an operation an earlier turn sent, or this one's.
    let sentBefore = false;
    let sending = false;
    try {
      await lateWatch?.();
      sentBefore = (await prisma.bulkOperationRecord.count({ where: { runId, kind: "MUTATION" } })) > 0;
      if (!client) {
        throw new AppError({
          code: "NO_SESSION",
          userMessage:
            "The app has no working session for this store, so the background worker could not go on writing this run. " +
            "Open the app again from Shopify admin, then Resume.",
          context: { runId },
        });
      }
      const total = run.writableRows ?? 0;

      // An operation a turn before this one sent, and died before reading (#832). Asked of Shopify
      // by its id, as a Resume would, before anything else is sent.
      const { settleSubmittedBulk } = await import("./execute.server");
      const settled = await settleSubmittedBulk(shopId, campaignId, client, { runId });
      if (settled && "stillRunning" in settled) {
        // As long as a turn would have waited for it, and no longer (#832): then the run stops,
        // its rows sent, and the campaign's next run asks Shopify how it ended.
        if (settled.submittedAt && Date.now() - settled.submittedAt.getTime() > BULK_WAIT_MS) {
          throw new AppError({
            code: "UNKNOWN",
            retryable: false,
            context: { runId, operation: settled.operation },
            userMessage:
              `Shopify is still applying this campaign's prices in bulk (operation ${settled.operation}), and the app has ` +
              "stopped waiting for it. They may already be live. The campaign's next run asks Shopify how it ended before " +
              "writing anything.",
          });
        }
        await endTurn(runId, null, total - (await outstandingRows(runId)));
        return { kind: "continues", runId, campaignId, delayMs: BULK_POLL_INTERVAL_MS };
      }

      const rows = await nextChunk(runId, shopId, held.size);
      let failures: string[] | null = null;
      if (rows.length > 0) {
        sending = true;
        const failed = await writeChunk(shopId, campaignId, runId, client, rows, {
          written: total - (await outstandingRows(runId)),
          total,
          beat,
          actor: options.actor,
        });
        if (failed.length > 0 && carry.failures.length < CARRY_FAILURES) {
          failures = [...carry.failures, ...failed].slice(0, CARRY_FAILURES);
          carry.failures = failures;
        }
      }

      const left = await outstandingRows(runId);
      if (left > 0) {
        await endTurn(runId, failures, total - left);
        return { kind: "continues", runId, campaignId };
      }
      const outcome = await finishChunks(shopId, campaignId, runId, run.kind, client, options, carry, beat);
      return { kind: "finished", runId, campaignId, revert: carry.revert, outcome };
    } catch (error) {
      // As a run written in one call ends when it throws. Prices may have changed once any turn
      // has sent an operation, whatever stopped this one; before that, a submission Shopify
      // refused sent nothing (#1054), and the campaign's claim is given back.
      const writing = sentBefore || (sending && !(error instanceof BulkSubmissionError));
      return endFailedRun(shopId, campaignId, options, { runId, writing, releaseTo: carry.releaseTo as CampaignState | undefined }, error);
    }
  });
}

/** The base-price rows a chunked run has still to send or hear back from. */
function outstandingRows(runId: string): Promise<number> {
  return prisma.variantChange.count({
    where: { runId, surfaceKind: "BASE", priceListGid: "", status: { in: ["PENDING", "WRITING"] } },
  });
}

/**
 * The next chunk of a run's ledger, as the plan wrote it: its oldest PENDING base-price rows.
 * Oldest first so the chunks go through the plan in its order; any order would do, since a row
 * a turn has sent is never PENDING again.
 */
async function nextChunk(runId: string, shopId: string, size: number): Promise<PlannedRow[]> {
  const rows = await prisma.variantChange.findMany({
    where: { runId, shopId, status: "PENDING", surfaceKind: "BASE", priceListGid: "" },
    orderBy: { id: "asc" },
    take: size,
    select: {
      variantGid: true,
      currency: true,
      beforePrice: true,
      beforeCompareAt: true,
      intendedPrice: true,
      intendedCompareAt: true,
      intendedCompareAtSet: true,
      failureReason: true,
    },
  });
  return rows.map(plannedRowOf);
}

/**
 * One chunk, written as a run written in one call writes its prices (#809, D34): its write
 * intents first, then one bulk operation whose rows say "sent" in the step that records it, its
 * result file read back, and every row recorded. The run's count is stamped as it goes, so the
 * page reads "Writing N of M" for the whole run. Answers why any row failed.
 */
async function writeChunk(
  shopId: string,
  campaignId: string,
  runId: string,
  client: AdminClient,
  rows: PlannedRow[],
  how: { written: number; total: number; beat: (written?: number, writable?: number) => Promise<void>; actor: string },
): Promise<string[]> {
  await recordWriteIntents(shopId, intentsOf(rows));
  const gids = rows.map((row) => row.ref.variantGid);
  const products = await productMapFor(shopId, gids);
  const result = await executeRows(rows, {
    client,
    shopId,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: 1,
    // The path the run chose for all its prices: a last chunk of a few hundred is not one to
    // write a product at a time.
    forcePath: "bulk",
    onProgress: (done) => how.beat(how.written + done, how.total),
    // This chunk's rows only, with the record of the operation that holds them (#832). Their
    // clamp reasons went in with the ledger.
    onSubmitted: async (operation) => {
      await retryTransient("run.bulk-submitted", () =>
        prisma.$transaction([
          recordOperation(shopId, runId, operation),
          ...chunk(gids, RUN_CHUNK).map((batch) =>
            prisma.variantChange.updateMany({
              where: { runId, shopId, status: "PENDING", surfaceKind: "BASE", priceListGid: "", variantGid: { in: batch } },
              data: { status: "WRITING" },
            }),
          ),
        ]),
      );
    },
    onPoll: recordPoll,
    onBulkWait: () => noteBulkWait(shopId, campaignId, { id: runId, actor: how.actor, prices: rows.length }),
  });
  return recordResults(runId, shopId, result.rows);
}

/**
 * Ends a turn with the run going on: waiting for its next, holding its shop, its count where the
 * turn left it. The carry's failures are written only when the turn added to them -- the rest of
 * the carry is the plan's, and a 100k run's is megabytes.
 */
async function endTurn(runId: string, failures: string[] | null, written: number): Promise<void> {
  const now = new Date();
  await retryTransient("run.turn-end", () =>
    prisma.$transaction([
      prisma.campaignRun.update({ where: { id: runId }, data: { heartbeatAt: now, writtenRows: written } }),
      ...(failures
        ? [
            prisma.$executeRaw`UPDATE "run_chunks" SET "carry" = jsonb_set("carry", '{failures}', ${JSON.stringify(failures)}::jsonb)
                                WHERE "runId" = ${runId}`,
          ]
        : []),
      prisma.runChunk.update({ where: { runId }, data: { waitingSince: now } }),
    ]),
  );
}

/**
 * A chunked run's last turn, once every chunk is written (#809, D34): the rest of the run, as a
 * run written in one call has it (`finishRun`), from what its plan kept and what its ledger says.
 * The campaigns are read again for the market step, as a market's own plan reads them when it
 * runs; the prices, the tags' and markets' variants and the counts are the plan's.
 */
async function finishChunks(
  shopId: string,
  campaignId: string,
  runId: string,
  kind: string,
  client: AdminClient,
  options: RunOptions,
  carry: ChunkCarry,
  beat: () => Promise<void>,
): Promise<RunOutcome> {
  // Every price sent and answered: Verifying, as a run written in one call says from here (#808).
  await prisma.campaignRun.updateMany({ where: { id: runId, status: "EXECUTING" }, data: { status: "VERIFYING" } }).catch(() => {});
  const { campaign, resolvable, breach } = await loadCampaignContext(shopId, campaignId);
  const products = await productMapFor(shopId, [...new Set([...carry.marketVariants, ...carry.winners.map(([gid]) => gid)])]);
  const tail: RunTail = {
    runId,
    kind: kind === "REVERT" ? "REVERT" : "APPLY",
    campaignName: campaign.name,
    resolvable,
    breach,
    wholeRevert: carry.wholeRevert,
    takeover: carry.winners.map(([variantGid, winner]) => ({ ref: { variantGid }, campaignId: winner })),
    marketVariants: carry.marketVariants,
    products,
    refusedMarkets: carry.refusedMarkets,
    ...(carry.marketsLandedIn ? { marketsLandedIn: carry.marketsLandedIn } : {}),
    unplanned: carry.unplanned,
    before: carry.before,
    counts: carry.counts,
    skips: carry.skips,
    unchanged: [],
    settledNote: carry.settledNote,
    kept: carry.kept,
    spared: carry.spared,
    resumedFrom: carry.resumedFrom,
    startedAt: carry.startedAt,
  };
  return finishRun(shopId, campaignId, client, options, tail, await writtenFromLedger(runId, carry.failures), beat);
}

/**
 * What a chunked run's turns wrote, from its ledger (#809, D34): what `executeRows` answers for a
 * run written in one call, counted over every chunk. The base price's rows only; markets count
 * their own (`outstandingMarketRows`).
 */
async function writtenFromLedger(runId: string, failures: string[]): Promise<Written> {
  const base = { runId, surfaceKind: "BASE" as const, priceListGid: "" };
  const [byStatus, landed] = await Promise.all([
    prisma.variantChange.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    prisma.variantChange.findMany({ where: { ...base, status: { in: [...LANDED] } }, select: { variantGid: true } }),
  ]);
  const count = (...statuses: string[]) =>
    byStatus.filter((group) => statuses.includes(group.status)).reduce((sum, group) => sum + group._count._all, 0);
  const failed = count("FAILED");
  // Written and not read back, or never answered: neither is verified (rule 5).
  const unverified = count("APPLIED", "WRITING", "PENDING");
  return {
    verified: landed.length,
    failed,
    unverified,
    clean: failed === 0 && unverified === 0,
    verifiedGids: landed.map((row) => row.variantGid),
    failures,
  };
}

/**
 * Why the plan left rows alone, in the merchant's terms.
 *
 * Shared with the editor's preview, which phrases the same reasons one row at a time.
 * Two copies would drift the moment a reason was added to the resolver.
 */
const SKIP_REASONS: Record<string, string> = SKIP_REASON_GROUP;

function describeSkips(rows: readonly PlannedRow[]): string[] {
  const byReason = new Map<string, number>();

  for (const row of rows) {
    if (row.status !== "skipped") continue;
    const reason = row.reason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  // Largest group first: a merchant reading one line wants the one that explains most of
  // the difference between what they expected and what happened.
  return [...byReason]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => {
      const what = SKIP_REASONS[reason];
      return what
        ? `${count} ${count === 1 ? "product was" : "products were"} skipped: they ${what}.`
        : `${count} ${count === 1 ? "product was" : "products were"} skipped (${reason}).`;
    });
}

/**
 * Adds or removes the campaign's tag kit alongside the price write.
 *
 * Failures are reported but never fail the run. A price that landed and a badge that
 * did not is a visibly incomplete campaign the merchant can retry; throwing here would
 * discard a successful price write over a cosmetic one, and the ledger already records
 * exactly which products are missing their tags.
 */
async function syncTags(
  shopId: string,
  campaignId: string,
  runId: string,
  /** Whom each variant goes to, for a revert's takeover tags. */
  rows: readonly WinnerRow[],
  /** Every variant whose product this run tags: the whole scope the plan did not set aside. */
  variantGids: readonly string[],
  products: Map<string, string>,
  client: AdminClient,
  options: RunOptions,
  beat: () => Promise<void>,
): Promise<{ messages: string[] } | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { tagKit: true },
  });

  try {
    if (options.revert) {
      // Scoped reverts leave tags alone: one variant coming out of a sale does not
      // un-badge the product, whose other variants are still in it.
      if (options.variantGids) return null;

      // Whoever now wins these variants gets its badges first, whether or not the
      // ending campaign had a tag kit of its own (#687).
      const handedOver = await applyTakeoverTags(
        shopId,
        campaignId,
        productsByWinner(rows, products),
        client,
        beat,
      );
      const outcome = await removeCampaignTags(shopId, campaignId, client, beat);

      const notes: string[] = [];
      if (outcome.failed > 0) {
        notes.push(`${countOf(outcome.failed, "product")} kept ${outcome.failed === 1 ? "its" : "their"} campaign tags — see the run for why.`);
      }
      if (handedOver.failed > 0) {
        notes.push(
          `${countOf(handedOver.failed, "product")} now priced by another campaign could not get ${handedOver.failed === 1 ? "its" : "their"} tags.`,
        );
      }
      return { messages: notes };
    }

    if (!campaign?.tagKit.length) return null;

    const productGids = [
      ...new Set(variantGids.map((gid) => products.get(gid)).filter((gid): gid is string => !!gid)),
    ];

    const outcome = await applyCampaignTags(
      shopId,
      campaignId,
      runId,
      productGids,
      campaign.tagKit,
      client,
      { onProgress: beat },
    );

    const notes: string[] = [];
    if (outcome.failed > 0) {
      notes.push(`${countOf(outcome.failed, "product")} could not be tagged — prices were still applied.`);
    }
    if (outcome.leftAlone > 0) {
      // Said out loud, because the alternative reading is that the app failed to tag
      // them. It did not: they were already tagged, and they are the merchant's.
      notes.push(
        outcome.leftAlone === 1
          ? "1 tag was already on its product and was left as it is."
          : `${countOf(outcome.leftAlone, "tag")} were already on their products and were left as they are.`,
      );
    }
    return { messages: notes };
  } catch (error) {
    return {
      messages: [
        `Prices were applied, but tagging did not finish: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

/** The products a revert handed to each campaign still running, keyed by that campaign. */
/** Executed rows by the Shopify timestamp their write produced (#932). */
function groupByRemoteStamp(rows: readonly { row: { ref: { variantGid: string } }; remoteUpdatedAt?: string }[]): Map<Date, string[]> {
  const byText = new Map<string, string[]>();
  for (const executed of rows) {
    if (!executed.remoteUpdatedAt) continue;
    const gids = byText.get(executed.remoteUpdatedAt) ?? [];
    gids.push(executed.row.ref.variantGid);
    byText.set(executed.remoteUpdatedAt, gids);
  }
  const out = new Map<Date, string[]>();
  for (const [text, gids] of byText) {
    const at = new Date(text);
    if (!Number.isNaN(at.getTime())) out.set(at, gids);
  }
  return out;
}

/** A variant and the campaign that prices it after this run. */
type WinnerRow = { ref: { variantGid: string }; campaignId?: string };

function productsByWinner(
  rows: readonly WinnerRow[],
  products: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const productGid = products.get(row.ref.variantGid);
    if (!row.campaignId || !productGid) continue;
    const set = out.get(row.campaignId) ?? new Set<string>();
    set.add(productGid);
    out.set(row.campaignId, set);
  }
  return new Map([...out].map(([id, set]) => [id, [...set]]));
}

/** Run states with no process behind them. */
const FINISHED_RUN = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

/** This occurrence already ran to an end; running it under the same key would do nothing. */
export class OccurrenceFinishedError extends Error {
  constructor(occurrenceKey: string, runId: string, status: string) {
    super(
      `This occurrence (${occurrenceKey}) already ran and ended ${status} (run ${runId}). ` +
        `Nothing was run again; the campaign was released so it can be retried.`,
    );
    this.name = "OccurrenceFinishedError";
  }
}

/** Prisma's unique-constraint violation, which here means somebody else got there first. */
function isOccurrenceTaken(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Stamps the run as still alive, at most once every few seconds.
 *
 * Throttled because the alternative is an UPDATE per product group, which on a large
 * sync run is thousands of writes to say nothing new. The reaper's staleness
 * threshold is minutes, so seconds of resolution is ample.
 *
 * Failures are swallowed on purpose. A heartbeat that could abort a run would mean
 * adding liveness reporting had made runs *less* reliable. The worst case of missed
 * stamps is a live run reclaimed as dead -- the campaign shows Partial and offers Resume
 * mid-write (#791) -- which is why every phase that writes stamps it, and why the reaper
 * also counts the run's own ledger rows as signs of life.
 *
 * The prices' executor also says how far it has got, and the stamp keeps that too (#820), in
 * the same update: nothing else that moves while prices are written can say how long the run
 * has left. The tags and market phases report nothing, and leave the count where the prices
 * finished. The count that finishes them is kept whatever the throttle says, once per run: a
 * last stamp of 980 of 1,000 would read as "under a minute left" for as long as tagging took.
 */
function heartbeat(runId: string, everyMs = HEARTBEAT_EVERY_MS) {
  let last = 0;

  return async (written?: number, writable?: number) => {
    const now = Date.now();
    const progress = written !== undefined && writable !== undefined;
    if (now - last < everyMs && !(progress && written >= writable)) return;
    last = now;

    try {
      await prisma.campaignRun.update({
        where: { id: runId },
        data: { heartbeatAt: new Date(now), ...(progress ? { writtenRows: written, writableRows: writable } : {}) },
      });
    } catch {
      // Liveness is a hint, never a reason to fail a run that is otherwise working.
    }
  };
}

/** The outcome shape for a scoped run, which reports rows without judging the campaign. */
function scopedOutcome(
  runId: string,
  planned: number,
  result: { verified: number; failed: number; unverified: number; clean: boolean },
  messages: string[],
): RunOutcome {
  return {
    runId,
    planned,
    verified: result.verified,
    failed: result.failed,
    unverified: result.unverified,
    clean: result.clean,
    messages: messages.slice(0, 5),
  };
}

/**
 * Ledgers the rows a person chose not to touch.
 *
 * Written as SKIPPED and already settled, so they never look like outstanding work to
 * a resume, and never count against a clean run. The reason is stored on the row
 * because the run view is where somebody asks why a variant they expected to change
 * did not.
 */
async function writeSparedRows(
  runId: string,
  shopId: string,
  rows: PlannedRow[],
  reason = SPARED_REASON,
  /** A resumed revert's carried rows (#1157), each with the reason it was first kept for. */
  keptFor: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (rows.length === 0) return;

  // In `RUN_CHUNK` batches, each retried (#810): a merchant keeping thousands of edits is
  // thousands of rows, and one createMany of them was one long statement.
  await inRunChunks("ledger.base.spared", rows, (batch) =>
    prisma.variantChange.createMany({
      data: batch.map((row) => ({
        runId,
        shopId,
        variantGid: row.ref.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: row.ref.currency,
        beforePrice: row.beforePrice ? BigInt(row.beforePrice.amount) : null,
        beforeCompareAt: row.beforeCompareAt ? BigInt(row.beforeCompareAt.amount) : null,
        intendedPrice: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
        intendedCompareAt: row.intendedCompareAt ? BigInt(row.intendedCompareAt.amount) : null,
        intendedCompareAtSet: row.intendedCompareAtSet,
        status: "SKIPPED" as const,
        failureReason: keptFor.get(row.ref.variantGid) ?? reason,
        appliedAt: new Date(),
      })),
      skipDuplicates: true,
    }),
  );
}

/** The Revert tab's "Leave as it is", which posts no reason of its own. */
const SPARED_REASON = "Left as it is: this price was changed outside the app and you chose to keep that edit.";

/**
 * The prices a run left as edited, by variant, with why (#1157): the base rows
 * `writeSparedRows` ledgered SKIPPED, each carrying the reason it was kept.
 *
 * Less a variant deleted while the run was in flight, which the executors also ledger
 * SKIPPED, in Shopify's words (E4): it was never an edit, and there is no price to keep.
 */
export async function editsKeptBy(runId: string): Promise<Map<string, string>> {
  const rows = await prisma.variantChange.findMany({
    where: { runId, status: "SKIPPED", surfaceKind: "BASE", priceListGid: "" },
    select: { variantGid: true, failureReason: true },
  });
  return new Map(
    rows
      .filter((row) => classifyFailure(row.failureReason ?? "").reason !== "variant-deleted")
      .map((row) => [row.variantGid, row.failureReason ?? SPARED_REASON]),
  );
}

/**
 * What the revert a Resume continues kept as edited (#1157); nothing when the run it
 * continues is an apply, which keeps no edits.
 */
async function editsKeptByResumed(campaignId: string): Promise<Map<string, string>> {
  const resumed = await runToResume(campaignId);
  return resumed?.kind === "REVERT" ? editsKeptBy(resumed.id) : new Map();
}

/**
 * Write-ahead ledger. Chunked so a large plan does not build one giant statement.
 *
 * And each chunk retried on its own (#810): a pool timeout on chunk 41 of 102 used to throw
 * the run away before a price was sent. `skipDuplicates` over the row's unique key is what
 * makes a retried chunk, or a chunk a previous attempt already wrote, a no-op.
 */
async function writeLedgerRows(
  runId: string,
  shopId: string,
  rows: PlannedRow[],
): Promise<void> {
  await inRunChunks("ledger.base.create", rows, (batch) =>
    prisma.variantChange.createMany({
      data: batch.map((row) => ({
        runId,
        shopId,
        variantGid: row.ref.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: row.ref.currency,
        beforePrice: row.beforePrice ? BigInt(row.beforePrice.amount) : null,
        beforeCompareAt: row.beforeCompareAt ? BigInt(row.beforeCompareAt.amount) : null,
        intendedPrice: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
        intendedCompareAt: row.intendedCompareAt ? BigInt(row.intendedCompareAt.amount) : null,
        intendedCompareAtSet: row.intendedCompareAtSet,
        status: "PENDING" as const,
      })),
      skipDuplicates: true,
    }),
  );
}

type ExecutedRows = Awaited<ReturnType<typeof executeRows>>["rows"];

/** Folds execution results back into the ledger, grouped to avoid a query per row. */
/**
 * The most recent attempt's ledger for this campaign.
 *
 * Only the latest run matters: each run's rows are a complete picture of what that
 * attempt achieved, and merging older ones would resurrect rows that a later attempt
 * has since settled.
 */
/**
 * The whole-campaign run a Resume continues: the latest one that is not a single-variant
 * revert or reinstate, which never change the campaign's state.
 *
 * A Resume continues *that* run, in its own direction (#702). After a partial revert the
 * page offered Resume, the route ran an apply, and the apply read the ledger of the last
 * *apply* -- every row VERIFIED, from before the revert undid them -- so it wrote nothing,
 * called the campaign ACTIVE and verified, and left the storefront mostly at full price.
 */
export async function runToResume(
  campaignId: string,
): Promise<{ id: string; kind: "APPLY" | "REVERT" } | null> {
  const run = await prisma.campaignRun.findFirst({
    where: {
      campaignId,
      kind: { in: ["APPLY", "REVERT"] },
      NOT: { occurrenceKey: { startsWith: "VARIANT-" } },
      // Not one handed to the worker and refused before it wrote anything (#808), CANCELLED; and
      // not one queued or being planned, which is the resume itself before it writes: a queued
      // run's row exists from the press, and found here, it resumed nothing and rewrote it all.
      status: { notIn: ["CANCELLED", "QUEUED", "PLANNING"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true },
  });
  return run ? { id: run.id, kind: run.kind as "APPLY" | "REVERT" } : null;
}

async function priorLedger(campaignId: string, kind: "APPLY" | "REVERT") {
  // The run being resumed, not the latest run of this kind. When the last whole run went
  // the other way, nothing it verified is evidence for this one: plan everything.
  const previous = await runToResume(campaignId);
  if (!previous || previous.kind !== kind) return [];

  // The base price's rows only (#1037); see `baseRowsOnly`.
  const changes = await prisma.variantChange.findMany({
    where: { runId: previous.id },
    select: { variantGid: true, status: true, attempt: true, surfaceKind: true, priceListGid: true },
  });

  return baseRowsOnly(
    changes.map((change) => ({
      variantGid: change.variantGid,
      status: change.status as LedgerState,
      attempt: change.attempt,
      surfaceKind: change.surfaceKind,
      priceListGid: change.priceListGid,
    })),
  );
}

async function recordResults(
  runId: string,
  shopId: string,
  rows: ExecutedRows,
): Promise<string[]> {
  const byStatus = new Map<"VERIFIED" | "CLAMPED" | "APPLIED" | "FAILED" | "SKIPPED", string[]>();
  const messages: string[] = [];

  for (const executed of rows) {
    // A variant deleted mid-run is SKIPPED, not FAILED. Recording it as a failure
    // would make an ordinary merchant action look like a defect, and a run full of
    // "failures" nobody needs to act on is a run nobody reads (E4).
    //
    // A clamped row is written and read back like any other, but at a price the rule did
    // not ask for. CLAMPED says so; VERIFIED left the ledger claiming the rule's own price
    // for thirteen free products raised to $0.01 (#792). Every reader of "what did we put
    // on the storefront" counts both -- see `LANDED`.
    const status =
      executed.status === "verified"
        ? executed.row.status === "clamped"
          ? "CLAMPED"
          : "VERIFIED"
        : executed.status === "failed"
          ? "FAILED"
          : executed.status === "skipped-deleted"
            ? "SKIPPED"
            : "APPLIED";

    const bucket = byStatus.get(status) ?? [];
    bucket.push(executed.row.ref.variantGid);
    byStatus.set(status, bucket);

    // Only genuine failures belong in the summary. A deleted variant has guidance
    // attached but is not something the merchant has to fix.
    if (executed.failureReason && executed.status === "failed") {
      messages.push(executed.guidance ?? executed.failureReason);
    }
  }

  // Every statement below in `RUN_CHUNK` batches, one after another, each retried on a
  // transient error (#810). This is where #802's run died: 55,000 prices verified, then a
  // pool timeout recording the rest, and the run Partial over prices that had landed.
  const now = new Date();
  for (const [status, gids] of byStatus) {
    await inRunChunks("ledger.base.result", gids, (batch) =>
      prisma.variantChange.updateMany({
        where: { runId, shopId, variantGid: { in: batch } },
        data: {
          status,
          appliedAt: status === "FAILED" ? null : now,
          verifiedAt: status === "VERIFIED" || status === "CLAMPED" ? now : null,
        },
      }),
    );
  }

  // Shopify's own timestamp for each write, which the mirror is stamped with (#932). A
  // product's variants share it and it is to the second, so grouped: a few statements per
  // second of writing, not one per row.
  for (const [stamp, gids] of groupByRemoteStamp(rows)) {
    await inRunChunks("ledger.base.stamp", gids, (batch) =>
      prisma.variantChange.updateMany({
        where: { runId, shopId, variantGid: { in: batch } },
        data: { remoteUpdatedAt: stamp },
      }),
    );
  }

  // The reason itself, by what raised the price: the merchant's guardrail, or the rule
  // that no price is ever zero or below -- which is not a guardrail (#792).
  for (const [reason, text] of CLAMP_REASONS) {
    const gids = rows
      .filter((executed) => executed.status === "verified" && executed.row.status === "clamped" && (executed.row.reason ?? "below-floor") === reason)
      .map((executed) => executed.row.ref.variantGid);
    if (gids.length === 0) continue;
    await inRunChunks("ledger.base.clamp", gids, (batch) =>
      prisma.variantChange.updateMany({
        where: { runId, shopId, variantGid: { in: batch } },
        data: { failureReason: text },
      }),
    );
  }

  // Failure reasons differ per row, so those are written individually -- but only
  // for the rows that actually failed, which is the rare case.
  for (const executed of rows) {
    if (!executed.failureReason) continue;
    // Retried only on the two codes that mean it did not commit, so the increment below
    // counts one failure once.
    await retryTransient("ledger.base.reason", () => prisma.variantChange.updateMany({
      where: { runId, shopId, variantGid: executed.row.ref.variantGid },
      data: {
        // Shopify's own words, then ours. Support needs the former; the merchant
        // needs the latter.
        failureReason: executed.guidance
          ? `${executed.guidance} (Shopify said: ${executed.failureReason})`
          : executed.failureReason,
        // The number the store actually holds, when the read-back found a different
        // one. The failure reason says it in prose; this says it in a column, so
        // reconciliation and support can act on it without parsing English.
        //
        // Only set on divergence: for a verified row the observed price equals the
        // intended one by definition, and writing it back per row would cost a query
        // each to record something already in `intendedPrice`.
        appliedPrice:
          executed.observedPrice !== undefined
            ? BigInt(executed.observedPrice.amount)
            : undefined,
        // Counts toward quarantine: a row that has burned its attempts is left alone
        // by the next resume rather than retried forever.
        attempt: { increment: 1 },
      },
    }));
  }

  return messages;
}

/** How many variants the campaign's scope covers, counted the way a run resolves it. */
/**
 * What a whole-campaign run will do, counted before it starts, for the inline budget.
 *
 * Products only below the bulk threshold: above it the run goes to Shopify's queue and has
 * no estimate to make. Tags are counted as every product in scope when the campaign has a
 * tag kit -- an apply adds them, a revert takes them off, one call a product either way.
 *
 * Also which lane a run the scheduler hands to the worker goes on (#809, `smallRun`).
 */
export async function inlineWork(shopId: string, campaignId: string): Promise<InlineWork> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { ...DEFINITION, tagKit: true },
  });
  const where = astToWhere(shopId, await scopeOf(shopId, campaign));
  const variants = await prisma.variantIndex.count({ where });
  const products =
    variants > DEFAULT_THRESHOLD ? 0 : (await prisma.variantIndex.groupBy({ by: ["productGid"], where })).length;
  return { variants, products, taggedProducts: campaign.tagKit.length > 0 ? products : 0 };
}

/**
 * Why a run the page could write is the worker's instead: another of the shop's runs holds the
 * shop's lease (#809). Names that run's campaign when the lease says which.
 */
async function shopBusyReason(shopId: string): Promise<string> {
  const holder = await runLeaseHolder(shopId);
  const campaign = holder?.campaignId
    ? await prisma.campaign.findFirst({ where: { id: holder.campaignId, shopId }, select: { name: true } })
    : null;
  return (
    `Another run is writing this store's prices right now${campaign ? ` ("${campaign.name}")` : ""}, and a store's runs are ` +
    "written one at a time, so this one waits for it."
  );
}

/** The states in which a full run holds the campaign's claim. */
const CLAIMED: ReadonlySet<string> = new Set(["APPLYING", "REVERTING"]);

interface LiveRun {
  id: string;
  kind: string;
  status: string;
  startedAt: Date | null;
  plannedRows: number;
}

/**
 * A whole-campaign run that has not finished, if there is one (#791).
 *
 * There can be at most one: `campaign_runs_one_live_run` is a unique index over exactly
 * these rows (#793).
 */
async function liveFullRun(campaignId: string, except?: string): Promise<LiveRun | null> {
  return prisma.campaignRun.findFirst({
    where: {
      campaignId,
      NOT: { occurrenceKey: { startsWith: "VARIANT-" } },
      status: { in: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] },
      ...(except ? { id: { not: except } } : {}),
    },
    select: { id: true, kind: true, status: true, startedAt: true, plannedRows: true },
  });
}

/**
 * A queued run's row, from planning to writing (#808): EXECUTING, with the plan's count and
 * the moment it starts writing, as the row a run writes where it was asked has always been
 * created. Conditional on PLANNING, so a row the reaper reclaimed meanwhile is never written
 * under: that would be two writers believing they own one ledger.
 */
async function startQueuedRun(runId: string, planned: number): Promise<{ id: string }> {
  const now = new Date();
  const moved = await prisma.campaignRun.updateMany({
    where: { id: runId, status: "PLANNING" },
    data: { status: "EXECUTING", plannedRows: planned, startedAt: now, heartbeatAt: now },
  });
  if (moved.count === 0) {
    throw new AppError({
      code: "UNKNOWN",
      userMessage: "This run stopped being the campaign's writer while it was being planned, so nothing was written. Reload the page to see where the campaign stands.",
      context: { runId },
    });
  }
  return { id: runId };
}

/** Stamps a queued run's heartbeat while it plans: see `runCampaign`. */
function planningBeat(runId: string): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void prisma.campaignRun
      .updateMany({ where: { id: runId, status: "PLANNING" }, data: { heartbeatAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_EVERY_MS);
}

/**
 * The outcome for a run that found another whole-campaign run already writing.
 *
 * The same action already under way is a deferral -- what was asked for is happening, so
 * Flow hears 200 and does not resend it into a second apply. A different action -- a
 * revert while the apply is still writing -- is refused for now: it clears on its own,
 * the page says to wait, and Flow's resend is the retry it needs.
 */
async function standDown(campaignId: string, live: LiveRun, options: RunOptions, planned: number): Promise<RunOutcome> {
  const message = await stillRunning(campaignId, live);
  const nothing = { runId: "", planned, verified: 0, failed: 0, unverified: 0, clean: true, messages: [message] };
  return live.kind === (options.revert ? "REVERT" : "APPLY")
    ? { ...nothing, runId: live.id, deferredTo: live.id }
    : { ...nothing, refused: message, transient: true };
}

/**
 * Why nothing new started: the campaign, the run already writing it -- when it started and
 * how much it covers -- and what to do instead (#793).
 *
 * Not how far it has got. Rows settle in the ledger when a run finishes, so a count taken
 * mid-run reads "nothing written yet" while prices are being written -- the very sentence
 * the issue quotes from the Runs tab.
 */
async function stillRunning(campaignId: string, live: LiveRun): Promise<string> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { name: true, shop: { select: { timezone: true } } },
  });
  const verb = live.kind === "REVERT" ? "reverted" : "applied";
  const started = live.startedAt
    ? ` that started ${formatAgo(live.startedAt, new Date(), campaign?.shop.timezone ?? "UTC")}`
    : "";
  const size = live.plannedRows > 0 ? ` over ${formatCount(live.plannedRows)} variants` : "";
  // A run handed to the worker has not started until the worker plans it (#808): it is named
  // as what it is, waiting or being planned, rather than as a run that started.
  const where =
    live.status === "QUEUED"
      ? `is already queued to be ${verb}${size}, waiting for the background worker`
      : live.status === "PLANNING"
        ? `is already being ${verb}${size}: the background worker is planning it`
        : `is still being ${verb} by a run${started}${size}`;
  return (
    `"${campaign?.name ?? "This campaign"}" ${where}, so nothing new was ` +
    "started and nothing is written twice. That run finishes on its own, and this page updates when it does; " +
    "watch it on the Runs tab."
  );
}

/** A run over named variants that is still writing, if there is one. */
async function liveScopedRun(campaignId: string): Promise<{ id: string } | null> {
  return prisma.campaignRun.findFirst({
    where: {
      campaignId,
      occurrenceKey: { startsWith: "VARIANT-" },
      status: { in: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] },
    },
    select: { id: true },
  });
}

/** Base-price variants this run wrote and read back. */
function verifiedVariants(rows: ExecutedRows): string[] {
  return rows
    .filter((executed) => executed.status === "verified" && executed.row.ref.priceListGid === "")
    .map((executed) => executed.row.ref.variantGid);
}



/**
 * Whether the shop's plan refuses to start this campaign, and why.
 *
 * Returns a merchant-facing sentence rather than throwing, because a scheduled run that
 * threw would surface as a failed run — and "your sale failed" is a much worse thing to
 * read than "your plan does not cover this campaign, here is the one that does".
 *
 * Called for applies only. There is a chaos scenario asserting that a downgraded shop
 * still reverts, which is the whole of edge case E8.
 */
async function refusedByPlan(
  shopId: string,
  campaignId: string,
  run: {
    /** The scope's size, when the inline budget has already counted it. */
    counted?: number;
    /** The variants a subset apply was sent. */
    only?: readonly string[];
  },
): Promise<string | null> {
  const { billingFor } = await import("../billing.server");
  const { canStart } = await import("../../lib/billing/plans");
  const { parseSurfaces } = await import("./market-surfaces.server");
  const { scopedSubsetSize } = await import("./scope-size.server");

  const [{ plan, exempt }, campaign] = await Promise.all([
    billingFor(shopId),
    prisma.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { surfaces: true, ...DEFINITION },
    }),
  ]);

  if (exempt || !campaign) return null;

  const surfaces = parseSurfaces(campaign.surfaces);
  const lists = surfaces.priceLists.length
    ? await prisma.priceListRecord.findMany({
        where: { shopId, priceListGid: { in: surfaces.priceLists } },
        select: { surfaceKind: true },
      })
    : [];

  // Counted from the campaign's own scope rather than the whole catalogue: the plan
  // meters variants *under management*, and a campaign targeting forty products on a
  // 500K store is forty variants under management.
  //
  // Through `scopeOf`, so a campaign targeting a segment is metered on what the segment
  // matches now — the same set its run will price. A subset's list too (#1075): it was
  // counted as sent, so a variant deleted since it was enrolled, or a gift card, counted
  // towards a limit the meter promised no campaign could reach, though `loadCandidates`
  // never prices either.
  const scope = async () => astToWhere(shopId, await scopeOf(shopId, campaign));
  const variants = run.only
    ? await scopedSubsetSize(await scope(), run.only)
    : (run.counted ?? (await prisma.variantIndex.count({ where: await scope() })));

  const verdict = canStart(plan, {
    variants,
    markets: lists.some((list) => list.surfaceKind !== "B2B"),
    b2b: lists.some((list) => list.surfaceKind === "B2B"),
  });

  return verdict.allowed ? null : verdict.message;
}


/**
 * Tells Shopify Flow what this run did.
 *
 * Never throws and never blocks. A trigger is a notification about work that already
 * happened; failing a campaign because an automation could not be told about it would be
 * the tail wagging the dog.
 */
async function fireCampaignTrigger(
  shopId: string,
  campaignId: string,
  campaignName: string,
  options: RunOptions,
  /** The rows the plan writes, for "products affected". */
  planned: number,
  result: { verified: number; clean: boolean },
): Promise<void> {
  try {
    const { fireTriggerForShop } = await import("../flow.server");

    if (options.revert) {
      await fireTriggerForShop(shopId, "campaign-ended", {
        "campaign id": campaignId,
        "campaign name": campaignName,
        outcome: result.clean ? "clean" : "partial",
        "products reverted": String(result.verified),
      });
      return;
    }

    await fireTriggerForShop(shopId, "campaign-started", {
      "campaign id": campaignId,
      "campaign name": campaignName,
      "products affected": String(planned),
    });
  } catch (error) {
    const { logger } = await import("../../lib/logging/logger");
    logger.info("could not fire a campaign trigger", {
      shopId,
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
