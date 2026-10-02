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

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { formatAgo, formatCount } from "../../lib/format/display";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { executeRows } from "./execute.server";
import type { PlannedRow } from "../../lib/planning/types";
import { planRun } from "../../lib/planning/plan";
import { recordWriteIntents, resolveOverwrittenDrift } from "../drift.server";
import { loadCandidates, productMapFor } from "./candidates.server";
import { isPractice, loadCampaignContext, scopeOf, importIdsOf} from "./model.server";
import { astToWhere } from "../segments.server";
import { DEFAULT_THRESHOLD } from "../../lib/planning/write-path";
import { AppError, toAppError } from "../../lib/errors/app-error";
import { LANDED } from "../../lib/execution/landed";
import { guardrailsFor } from "../settings.server";
import type { RunOutcome } from "./types";
import { inChunksCounting } from "../../lib/db/chunk";
import { overBudget, refuseInline, type InlineWork } from "../../lib/execution/inline-budget";
import { releaseClaim, transitionCampaign } from "./lifecycle.server";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { SKIP_REASON_GROUP } from "../../lib/planning/reasons";
import { planResume, type LedgerState } from "../../lib/execution/resume";
import { applyCampaignTags, applyTakeoverTags, removeCampaignTags } from "./tags.server";
import {
  applyMarketSurfaces,
  captureMarketBaselinesFirst,
  revertMarketSurfaces,
} from "./market-surfaces.server";
import { notify } from "../notifications.server";
import { HEARTBEAT_EVERY_MS } from "./reaper.server";
import { metric } from "../../lib/telemetry/metrics";
import { addLogContext, withLogContext } from "../../lib/logging/context.server";

export interface RunOptions {
  revert?: boolean;
  /** Who asked for this run, recorded on anything it resolves on their behalf (#755). */
  actor?: string;
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
   * How long this caller can wait for the writing, in milliseconds. A run estimated to
   * take longer -- or one that goes to Shopify's bulk queue, which has no estimate -- is
   * handed to the background worker instead of starting here (#790).
   *
   * Set by the web routes, which run inside an HTTP request that gets closed after five
   * minutes, and by Flow, which waits ten seconds. Left unset by the worker and the
   * scheduler, which have no request attached -- the ceiling is a property of the
   * caller, not of the campaign. See `inline-budget.ts`.
   */
  inlineBudgetMs?: number;
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
   * Continue an interrupted run instead of starting fresh.
   *
   * Rows the previous attempt verified are left untouched, so a resumed run converges
   * on the state a clean run would have produced (E2) without paying to rewrite work
   * that already landed.
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
}

export async function runCampaign(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions = {},
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
  const releaseTo = (options.claimedFrom ?? before?.status) as CampaignState | undefined;

  // Set by `executeCampaignRun` as soon as the run row exists; read by the catch below.
  const started: Started = {};

  try {
    // Every line this run produces carries the shop and the campaign, and the run id
    // from the moment there is one. Bound here rather than in the worker because this is
    // the function both callers share: a queued apply arrives through the job wrapper,
    // an inline Apply or Revert arrives straight from a route, and per CLAUDE.md rule 2
    // both genuinely write. Binding at the job alone would have left the web half — the
    // half a merchant is watching — with no ids at all.
    //
    // Merges with the job's context when there is one, so a queued run keeps its job id.
    const outcome = await withLogContext({ shopId, campaignId }, () =>
      executeCampaignRun(shopId, campaignId, client, options, started),
    );

    // A refusal -- waiting for approval, over the inline limit, refused by the plan -- is
    // a return, not a throw, so the catch below never saw it. When the scheduler had
    // claimed the campaign, it stayed APPLYING with nothing behind it: the sale never
    // started, approving it later changed nothing, and nothing ever reverted it (#701).
    // Released back to where the scheduler took it from, so the next tick asks again.
    // A full run that stood down for a scoped one (#763) took its claim itself, so it
    // gives it back whoever started it.
    if (
      outcome.refused &&
      releaseTo &&
      (options.claimedFrom || outcome.deferredTo) &&
      releaseTo !== "APPLYING" &&
      releaseTo !== "REVERTING"
    ) {
      await releaseClaim(shopId, campaignId, releaseTo, {
        reason: outcome.refused,
        // The scheduler asks every tick while the reason stands. One activity entry
        // says why; a new one every thirty seconds would bury it.
        quietIfRepeated: true,
      });
    }

    return outcome;
  } catch (error) {
    // The run row reaches a terminal state before anything else happens. Without this a
    // throw between creating the row and the update at the end of `executeCampaignRun`
    // left it EXECUTING for ever: `releaseClaim` below frees the *campaign*, so nothing
    // looked stuck, and the run sat in the ledger claiming to be in progress with no
    // process behind it. #649 found it on the bulk path, where a refused submission
    // throws straight past the terminal update, but the gap was never specific to that
    // path — every `await` after the row is created had it.
    const failed = await failRun(started.runId, error, started.writing === true);

    // It wrote, then threw (#802). Handing the campaign back to where it started -- Draft,
    // for a manual apply -- told the merchant "nothing has been written to your storefront"
    // over 54,168 prices at 10% off, nothing owned them, and Revert does not work on a
    // draft. The honest state is Partial, with what the ledger says landed, and the message
    // says prices changed. Only when this throw ended the run: one after it completed --
    // the mirror refresh, a notification -- leaves the finished run's state alone. A run
    // over named variants never held the campaign, so it has no state to move.
    if (failed?.ended && started.writing && !options.variantGids) {
      try {
        await transitionCampaign(shopId, campaignId, "PARTIAL", {
          reason:
            `${options.revert ? "revert" : "apply"} stopped part-way, after ${failed.verified} of ${failed.planned} ` +
            `prices were changed and read back: ${error instanceof Error ? error.message : String(error)}`,
          runId: started.runId,
        });
      } catch (transitionError) {
        const { logger } = await import("../../lib/logging/logger");
        logger.error("a run stopped part-way and its campaign could not be marked partial", {
          campaignId,
          runId: started.runId,
          error: transitionError instanceof Error ? transitionError.message : String(transitionError),
        });
      }
      throw stoppedPartWay(error, failed, options);
    }

    // Only release to a state that is not itself a claim. A campaign that was already
    // APPLYING when this was called -- a resume, a second worker -- has nowhere to be
    // put back to, and `releaseClaim` additionally refuses while any run is still live.
    if (releaseTo && releaseTo !== "APPLYING" && releaseTo !== "REVERTING") {
      await releaseClaim(shopId, campaignId, releaseTo, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/** Filled in as a run gets going, for the catch in `runCampaign`. */
interface Started {
  /** The run row, once it exists. */
  runId?: string;
  /** Set as the first price is sent: from here, a failure may have changed the storefront. */
  writing?: boolean;
}

interface FailedRun {
  /** Whether this call ended the run, rather than finding it already finished. */
  ended: boolean;
  /** Rows written and read back (VERIFIED or CLAMPED). */
  verified: number;
  /** Rows written and never read back. */
  applied: number;
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
    if (writing && ended.count > 0) {
      await prisma.variantChange.updateMany({ where: { runId, status: "WRITING" }, data: { status: "PENDING" } });
      await settleMirror(runId);
    }
    return { ended: ended.count > 0, verified, applied, planned: run?.plannedRows ?? 0 };
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
 * The mirror, from a run's ledger: what this run left live on the storefront.
 *
 * A row read back from Shopify says its price is live. Every other row this run may have
 * sent -- failed, written but never read back, or still pending when it stopped -- is
 * unknown, and null is the honest answer: the planner never treats an absent live price as
 * already correct, so the next run writes it, and drift reads null as "we have not looked".
 * Asserting the pre-run price instead is how a revert finds a written row "already at
 * baseline", writes nothing and reports clean with the sale still live; asserting the
 * intended price for an unverified row is how a resume finds it "already correct" (#699).
 *
 * For every run, done before the run or its campaign says it has finished (#906): it used
 * to run row by row after the campaign read Active. And for a run that throws after it
 * started writing (#802), which never reaches that point at all.
 */
async function settleMirror(runId: string): Promise<void> {
  const landed = Prisma.sql`c."runId" = ${runId} AND c."surfaceKind" = 'BASE' AND c."status" IN ('VERIFIED', 'CLAMPED') AND c."intendedPrice" IS NOT NULL`;
  const unknown = Prisma.sql`c."runId" = ${runId} AND c."surfaceKind" = 'BASE' AND c."status" IN ('PENDING', 'WRITING', 'APPLIED', 'FAILED')`;

  await prisma.$executeRaw`
    UPDATE "price_surface_entries" e
    SET "livePrice" = c."intendedPrice",
        "liveCompareAt" = CASE WHEN c."intendedCompareAtSet" THEN c."intendedCompareAt" ELSE e."liveCompareAt" END,
        "syncedAt" = NOW()
    FROM "variant_changes" c
    WHERE ${landed} AND e."shopId" = c."shopId" AND e."variantGid" = c."variantGid"
      AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''`;
  await prisma.$executeRaw`
    UPDATE "variant_index" v
    SET "price" = c."intendedPrice",
        "compareAt" = CASE WHEN c."intendedCompareAtSet" THEN c."intendedCompareAt" ELSE v."compareAt" END,
        "syncedAt" = NOW()
    FROM "variant_changes" c
    WHERE ${landed} AND v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"`;
  await prisma.$executeRaw`
    UPDATE "price_surface_entries" e
    SET "livePrice" = NULL, "liveCompareAt" = NULL, "syncedAt" = NOW()
    FROM "variant_changes" c
    WHERE ${unknown} AND e."shopId" = c."shopId" AND e."variantGid" = c."variantGid"
      AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''`;
  await prisma.$executeRaw`
    UPDATE "variant_index" v
    SET "price" = NULL, "compareAt" = NULL, "syncedAt" = NOW()
    FROM "variant_changes" c
    WHERE ${unknown} AND v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"`;
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
      ? `${formatCount(changed)} of ${formatCount(failed.planned)} prices were changed before it did, so your storefront ` +
        "has some of this campaign's prices and not others."
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
  options: RunOptions = {},
  /**
   * Filled in the moment the run row exists, so the caller's catch can finish it.
   *
   * An out-parameter rather than a return value because the thing that needs it is the
   * failure path, which by definition never reaches a return. See `failRun`.
   */
  started: Started = {},
): Promise<RunOutcome> {
  // Practice campaigns never write. Refused here, in the one function that writes
  // prices, rather than only in the UI that offers the button: the merchant was told
  // nothing would be written, and that has to hold against a scheduler tick, a stray
  // caller, or a future button somebody adds without knowing.
  const practising = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { schedule: true },
  });
  if (practising && isPractice(practising)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "This is a practice campaign, so it cannot be applied — that is the point of it. " +
        "Create a real campaign with the same scope and rule when you are ready.",
      context: { campaignId },
    });
  }

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
    const live = await liveFullRun(campaignId);
    if (live) return standDown(campaignId, live, options, 0);
  }

  // What this run will write, for the inline budget (#790). Counted only for a caller
  // that declared a deadline, and only for a whole-campaign run: a scoped run is a
  // handful of variants by construction, and handing one to the worker would take the
  // whole campaign's claim for it.
  const work =
    options.inlineBudgetMs !== undefined && !options.variantGids ? await inlineWork(shopId, campaignId) : undefined;

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

    // How many variants this run will attempt: the list a subset apply was sent, or the
    // count the budget already made. The plan gate counts for itself otherwise.
    const scopedCount = options.variantGids?.length ?? work?.variants;

    const refusal = await refusedByPlan(shopId, campaignId, scopedCount);
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

  // A run too long for the caller's deadline goes to the worker instead of running here
  // (#772, #790), after the approval and plan gates have had their say, and before the
  // claim below, because handing it over takes the claim itself.
  const tooLongHere = work ? overBudget(work, options.inlineBudgetMs!) : null;
  if (tooLongHere) {
    const { queueRun } = await import("./queued-run.server");
    const queued = await queueRun(shopId, campaignId, tooLongHere, {
      revert: options.revert === true,
      resume: options.resume,
      actor: options.actor,
      skipVariantGids: options.skipVariantGids,
      skipReason: options.skipReason,
    });
    if (queued) return queued;
    // No worker queue. A revert runs here as it always did -- ending a sale must always be
    // possible. An apply is refused: writing past the deadline is the one outcome this
    // exists to prevent. Clean, because nothing is half-done.
    if (!options.revert) {
      const message = refuseInline(tooLongHere);
      return { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true, messages: [message], refused: message };
    }
  }

  if (!options.variantGids) {
    await transitionCampaign(shopId, campaignId, options.revert ? "REVERTING" : "APPLYING", {
      reason: options.resume ? "resume requested" : options.revert ? "revert requested" : "apply requested",
    });

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
  const { campaign: campaignRecord, resolvable, ast } = await loadCampaignContext(shopId, campaignId);
  const campaignName = campaignRecord.name;
  const [candidates, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast, options.variantGids, importIdsOf(resolvable)),
    guardrailsFor(shopId),
  ]);

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: options.revert ? campaignId : undefined,
  });

  if (outcome.kind === "blocked") {
    throw new Error(
      `Campaign blocked by a guardrail on ${outcome.ref.variantGid}: ${outcome.reason}. ` +
        `No prices were changed -- a blocking guardrail stops the whole run.`,
    );
  }

  const kind = options.revert ? "REVERT" : "APPLY";
  const leaveAlone = new Set(options.skipVariantGids ?? []);

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
  if (options.resume && !options.revert) {
    const prior = await priorLedger(campaignId, kind);
    if (prior.length > 0) {
      const plan = planResume(writable, prior);
      writable = plan.todo;
      resumedFrom = { verified: plan.alreadyVerified, quarantined: plan.quarantined };
    }
  }

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
    run = await prisma.campaignRun.create({
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
  await writeSparedRows(run.id, shopId, spared, options.skipReason);

  // Record intents before writing: every price we write produces a products/update
  // webhook moments later, and without this the drift detector would flag our own
  // writes and bury the merchant in false events.
  await recordWriteIntents(
    shopId,
    writable.map((row) => ({
      variantGid: row.ref.variantGid,
      price: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
      // A row that leaves compare-at alone did not decide it, so its echo is matched on
      // price alone (#731). A row that clears it intends `null`, and says so.
      compareAt: !row.intendedCompareAtSet
        ? ("leave" as const)
        : row.intendedCompareAt
          ? BigInt(row.intendedCompareAt.amount)
          : null,
    })),
  );

  const products = await productMapFor(
    shopId,
    writable.map((row) => row.ref.variantGid),
  );

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
      // A scoped run's whole scope, not only the rows its base surface writes: a variant
      // already at its base price may still need its markets priced (#763).
      options.variantGids ?? writable.map((row) => row.ref.variantGid),
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
  const beat = heartbeat(run.id);

  // From here a failure may have changed the storefront (#802).
  started.writing = true;

  const result = await executeRows(writable, {
    client,
    shopId,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: options.verifySampleRate ?? 1,
    forcePath: options.forcePath,
    onProgress: beat,
  });

  const messages = await recordResults(run.id, shopId, result.rows);
  messages.unshift(...messagesBeforeExecution);

  // Tags after prices, deliberately. A badge on a product still showing full price is
  // worse than a price change nobody has badged yet, so the storefront never claims a
  // sale that has not landed.
  const tagOutcome = await syncTags(shopId, campaignId, run.id, writable, products, client, options, beat);
  if (tagOutcome) messages.push(...tagOutcome.messages);

  // Markets, after the base surface. A campaign that only ever touched the base price
  // does nothing for a merchant selling into four markets — their EUR and JPY customers
  // see the old price for the whole sale. Failures here are reported and never fail the
  // run: the base prices already landed, and the ledger names every market row that did
  // not.
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
          run.id,
          options.revert ? resolvable.filter((campaign) => campaign.id !== campaignId) : resolvable,
          options.variantGids,
          client,
          refusedMarkets,
          { perProductOnly: true, onProgress: beat },
        )
      : options.revert
        ? await revertMarketSurfaces(shopId, campaignId, client, beat)
        : await applyMarketSurfaces(
            shopId,
            campaignId,
            run.id,
            resolvable,
            writable.map((row) => row.ref.variantGid),
            client,
            refusedMarkets,
            { onProgress: beat },
          );

    for (const market of markets) {
      if (market.failed > 0) {
        messages.push(
          `${market.name} (${market.currency}): ${market.failed} price(s) did not apply.`,
        );
      }
      messages.push(...market.messages);
    }
  } catch (error) {
    messages.push(
      `Base prices were applied, but market prices did not finish: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The mirror, before anything says this run is over (#906). It was refreshed row by row
  // -- two queries a variant, 204,000 for a 102,132-variant apply -- *after* the campaign
  // read Active, so for minutes the campaign looked finished over a mirror still holding
  // pre-run prices. A revert started in that window planned 3,831 variants as already at
  // baseline, skipped them, and reported clean with the sale live; the late refresh then
  // overwrote 2,514 rows the revert had just restored. Now it is a handful of statements
  // from the ledger, done before the run row or the campaign says "finished".
  await settleMirror(run.id);

  await prisma.campaignRun.update({
    where: { id: run.id },
    data: {
      status: result.clean ? "COMPLETED" : "PARTIAL",
      verifiedRows: result.verified,
      failedRows: result.failed,
      skippedRows: outcome.counts.skipped,
      finishedAt: new Date(),
    },
  });

  // A run over a named handful of variants says nothing about the campaign as a
  // whole. Reverting one variant out of a four-thousand-variant sale must not mark
  // the sale COMPLETED -- it is still running, for everything else. The ledger records
  // what happened to those rows; the campaign's own state is left alone.
  if (options.variantGids) {
    await resolveOverwrittenDrift(shopId, run.id, verifiedVariants(result.rows), kind, options.actor);

  // The headline panels, from the one place that knows the answer. Counts and durations
  // only — the ledger holds what actually changed.
  metric("run.duration_ms", Date.now() - startedAt, { shopId, campaignId, kind });
  metric("run.verified_clean_rate", result.clean ? 1 : 0, { shopId, campaignId, kind });
  metric("run.rows", result.verified, { shopId, campaignId, outcome: "verified" });
  if (result.failed > 0) metric("run.rows", result.failed, { shopId, campaignId, outcome: "failed" });
  if (result.unverified > 0) {
    metric("run.rows", result.unverified, { shopId, campaignId, outcome: "unverified" });
  }
    return scopedOutcome(run.id, outcome.counts.planned, result, messages);
  }

  // Through the state machine, not a direct write: it enforces which moves are legal
  // and records how the campaign got here. A run that finishes late must not clobber a
  // newer state, which a bare update would happily do.
  const finalState = options.revert
    ? result.clean
      ? "COMPLETED"
      : "PARTIAL"
    : result.clean
      ? "ACTIVE"
      : "PARTIAL";

  await transitionCampaign(shopId, campaignId, finalState, {
    reason: `${options.revert ? "revert" : "apply"} finished: ${result.verified} verified, ${result.failed} failed`,
    runId: run.id,
  });

  // A held campaign can still be applied; whatever this run wrote over an edit made
  // outside Anchor now stands, and the drift queue must stop asking about it (#755).
  await resolveOverwrittenDrift(shopId, run.id, verifiedVariants(result.rows), kind, options.actor);

  // The headline panels, from the one place that knows the answer. Counts and durations
  // only — the ledger holds what actually changed.
  metric("run.duration_ms", Date.now() - startedAt, { shopId, campaignId, kind });
  metric("run.verified_clean_rate", result.clean ? 1 : 0, { shopId, campaignId, kind });
  metric("run.rows", result.verified, { shopId, campaignId, outcome: "verified" });
  if (result.failed > 0) metric("run.rows", result.failed, { shopId, campaignId, outcome: "failed" });
  if (result.unverified > 0) {
    metric("run.rows", result.unverified, { shopId, campaignId, outcome: "unverified" });
  }

  // Best-effort, and deliberately last. A campaign runs for hours; the merchant has to
  // be able to close the tab and still learn the outcome. Nothing about a mail
  // provider is allowed to change what happened to their prices, so this never throws
  // and never blocks the outcome being returned.
  void notify(shopId, {
    campaignId,
    kind: options.revert
      ? "revert-completed"
      : result.clean
        ? "run-completed"
        : "run-partial",
    campaignName: campaignName ?? "Your campaign",
    counts: {
      verified: result.verified,
      failed: result.failed,
      unverified: result.unverified,
      skipped: outcome.counts.skipped,
      clamped: outcome.counts.clamped,
    },
    reasons: messages.slice(0, 5),
  });

  // Told after the fact, never awaited for correctness. A campaign must not fail because
  // an automation could not be notified about it.
  await fireCampaignTrigger(shopId, campaignId, campaignRecord.name, options, outcome, result);

  return {
    runId: run.id,
    planned: outcome.counts.planned,
    verified: result.verified,
    failed: result.failed,
    unverified: result.unverified,
    clean: result.clean,
    messages: [
      // Lead with what was skipped. "Applied 3 variants" after a 1,500-row campaign
      // looks like a catastrophe until you know the other 1,497 were already correct
      // and deliberately left alone.
      //
      // Two independent things skip work, and the merchant does not care which: the
      // planner drops rows already showing the target price, and the resume drops rows
      // the ledger says were verified. Reporting only the latter said "0 rows were
      // already verified" straight after a run that had verified two of them.
      ...(resumedFrom && resumedFrom.verified + outcome.counts.noop > 0
        ? [
            `Resumed: ${resumedFrom.verified + outcome.counts.noop} rows were already correct and left untouched` +
              (resumedFrom.quarantined > 0
                ? `, ${resumedFrom.quarantined} quarantined after repeated failures`
                : "") +
              ".",
          ]
        : []),
      // Rows the plan decided not to write, grouped by why. Previously only *resume*
      // skips were reported, so a campaign that skipped four hundred products for a
      // nameable reason — no cost, below a floor, not in the imported file — handed the
      // merchant a smaller number than they expected and no explanation for it. The
      // count was in the database; it was just never said out loud.
      ...describeSkips(outcome.rows),
      ...messages.slice(0, 5),
    ],
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
  rows: PlannedRow[],
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
        notes.push(`${outcome.failed} product(s) kept their campaign tags — see the run for why.`);
      }
      if (handedOver.failed > 0) {
        notes.push(
          `${handedOver.failed} product(s) now priced by another campaign could not get its tags.`,
        );
      }
      return { messages: notes };
    }

    if (!campaign?.tagKit.length) return null;

    const productGids = [
      ...new Set(rows.map((row) => products.get(row.ref.variantGid)).filter((gid): gid is string => !!gid)),
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
      notes.push(`${outcome.failed} product(s) could not be tagged — prices were still applied.`);
    }
    if (outcome.leftAlone > 0) {
      // Said out loud, because the alternative reading is that the app failed to tag
      // them. It did not: they were already tagged, and they are the merchant's.
      notes.push(
        `${outcome.leftAlone} tag(s) were already on their products and were left as they are.`,
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
function productsByWinner(
  rows: readonly PlannedRow[],
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
 */
function heartbeat(runId: string, everyMs = HEARTBEAT_EVERY_MS) {
  let last = 0;

  return async () => {
    const now = Date.now();
    if (now - last < everyMs) return;
    last = now;

    try {
      await prisma.campaignRun.update({
        where: { id: runId },
        data: { heartbeatAt: new Date(now) },
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
  result: Awaited<ReturnType<typeof executeRows>>,
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
  reason = "Left as it is: this price was changed outside the app and you chose to keep that edit.",
): Promise<void> {
  if (rows.length === 0) return;

  await prisma.variantChange.createMany({
    data: rows.map((row) => ({
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
      failureReason: reason,
      appliedAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

/** Write-ahead ledger. Chunked so a large plan does not build one giant statement. */
async function writeLedgerRows(
  runId: string,
  shopId: string,
  rows: PlannedRow[],
): Promise<void> {
  const CHUNK = 1_000;

  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.variantChange.createMany({
      data: rows.slice(i, i + CHUNK).map((row) => ({
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
    });
  }
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

  const changes = await prisma.variantChange.findMany({
    where: { runId: previous.id },
    select: { variantGid: true, status: true, attempt: true },
  });

  return changes.map((change) => ({
    variantGid: change.variantGid,
    status: change.status as LedgerState,
    attempt: change.attempt,
  }));
}

/** The Reason column for a clamped row, by what raised it. */
const CLAMP_REASONS: ReadonlyArray<[string, string]> = [
  ["below-floor", "Raised to your guardrail floor: the rule would have priced it below it."],
  ["non-positive-price", "Raised to the smallest price: the rule would have priced it at zero or below."],
];

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

  const now = new Date();
  for (const [status, gids] of byStatus) {
    await inChunksCounting(gids, (batch) =>
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

  // The reason itself, by what raised the price: the merchant's guardrail, or the rule
  // that no price is ever zero or below -- which is not a guardrail (#792).
  for (const [reason, text] of CLAMP_REASONS) {
    const gids = rows
      .filter((executed) => executed.status === "verified" && executed.row.status === "clamped" && (executed.row.reason ?? "below-floor") === reason)
      .map((executed) => executed.row.ref.variantGid);
    if (gids.length === 0) continue;
    await inChunksCounting(gids, (batch) =>
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
    await prisma.variantChange.updateMany({
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
    });
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
 */
async function inlineWork(shopId: string, campaignId: string): Promise<InlineWork> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { schedule: true, tagKit: true },
  });
  const where = astToWhere(shopId, await scopeOf(shopId, campaign));
  const variants = await prisma.variantIndex.count({ where });
  const products =
    variants > DEFAULT_THRESHOLD ? 0 : (await prisma.variantIndex.groupBy({ by: ["productGid"], where })).length;
  return { variants, products, taggedProducts: campaign.tagKit.length > 0 ? products : 0 };
}

/** The states in which a full run holds the campaign's claim. */
const CLAIMED: ReadonlySet<string> = new Set(["APPLYING", "REVERTING"]);

interface LiveRun {
  id: string;
  kind: string;
  startedAt: Date | null;
  plannedRows: number;
}

/**
 * A whole-campaign run that has not finished, if there is one (#791).
 *
 * There can be at most one: `campaign_runs_one_live_run` is a unique index over exactly
 * these rows (#793).
 */
async function liveFullRun(campaignId: string): Promise<LiveRun | null> {
  return prisma.campaignRun.findFirst({
    where: {
      campaignId,
      NOT: { occurrenceKey: { startsWith: "VARIANT-" } },
      status: { in: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] },
    },
    select: { id: true, kind: true, startedAt: true, plannedRows: true },
  });
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
  return (
    `"${campaign?.name ?? "This campaign"}" is still being ${verb} by a run${started}${size}, so nothing new was ` +
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
  scopedCount: number | undefined,
): Promise<string | null> {
  const { billingFor } = await import("../billing.server");
  const { canStart } = await import("../../lib/billing/plans");
  const { parseSurfaces } = await import("./market-surfaces.server");

  const [{ plan, exempt }, campaign] = await Promise.all([
    billingFor(shopId),
    prisma.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { surfaces: true, schedule: true },
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
  const variants =
    scopedCount ??
    (await prisma.variantIndex.count({
      // Through `scopeOf`, so a campaign targeting a segment is metered on what the
      // segment matches now — the same set its run will price.
      where: astToWhere(shopId, await scopeOf(shopId, campaign)),
    }));

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
  outcome: Extract<ReturnType<typeof planRun>, { kind: "ok" }>,
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
      "products affected": String(outcome.counts.planned),
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
