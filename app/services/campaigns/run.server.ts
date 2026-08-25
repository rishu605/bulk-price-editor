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

import prisma from "../../db.server";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { executeRows } from "./execute.server";
import type { PlannedRow } from "../../lib/planning/types";
import { planRun } from "../../lib/planning/plan";
import { recordWriteIntents } from "../drift.server";
import { loadCandidates, productMapFor } from "./candidates.server";
import { loadCampaignContext } from "./model.server";
import { guardrailsFor } from "../settings.server";
import type { RunOutcome } from "./types";
import { transitionCampaign } from "./lifecycle.server";
import { planResume, type LedgerState } from "../../lib/execution/resume";
import { applyCampaignTags, removeCampaignTags } from "./tags.server";
import { notify } from "../notifications.server";

export interface RunOptions {
  revert?: boolean;
  /**
   * Fraction of applied rows to read back. Defaults to full verification, which
   * suits the catalogue sizes the sync path handles; the bulk path gets per-row
   * confirmation from its result file instead.
   */
  verifySampleRate?: number;
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
}

export async function runCampaign(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions = {},
): Promise<RunOutcome> {
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
  if (!options.variantGids) {
    await transitionCampaign(shopId, campaignId, options.revert ? "REVERTING" : "APPLYING", {
      reason: options.resume ? "resume requested" : options.revert ? "revert requested" : "apply requested",
    });
  }

  const { campaign: campaignRecord, resolvable, ast } = await loadCampaignContext(shopId, campaignId);
  const campaignName = campaignRecord.name;
  const [candidates, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast, options.variantGids),
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
  } catch (error) {
    if (!isOccurrenceTaken(error)) throw error;

    const existing = await prisma.campaignRun.findFirst({
      where: { campaignId, occurrenceKey, kind },
      select: { id: true },
    });

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

  await writeLedgerRows(run.id, shopId, writable);
  await writeSparedRows(run.id, shopId, spared);

  // Record intents before writing: every price we write produces a products/update
  // webhook moments later, and without this the drift detector would flag our own
  // writes and bury the merchant in false events.
  await recordWriteIntents(
    shopId,
    writable.map((row) => ({
      variantGid: row.ref.variantGid,
      price: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
      compareAt:
        row.intendedCompareAtSet && row.intendedCompareAt
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
  const result = await executeRows(writable, {
    client,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: options.verifySampleRate ?? 1,
    onProgress: heartbeat(run.id),
  });

  const messages = await recordResults(run.id, shopId, result.rows);

  // Tags after prices, deliberately. A badge on a product still showing full price is
  // worse than a price change nobody has badged yet, so the storefront never claims a
  // sale that has not landed.
  const tagOutcome = await syncTags(shopId, campaignId, run.id, writable, products, client, options);
  if (tagOutcome) messages.push(...tagOutcome.messages);

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
    await refreshMirror(shopId, result.rows);
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

  await refreshMirror(shopId, result.rows);

  // Best-effort, and deliberately last. A campaign runs for hours; the merchant has to
  // be able to close the tab and still learn the outcome. Nothing about a mail
  // provider is allowed to change what happened to their prices, so this never throws
  // and never blocks the outcome being returned.
  void notify(shopId, {
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
      ...messages.slice(0, 5),
    ],
  };
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
): Promise<{ messages: string[] } | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { tagKit: true },
  });
  if (!campaign?.tagKit.length) return null;

  try {
    if (options.revert) {
      // Scoped reverts leave tags alone: one variant coming out of a sale does not
      // un-badge the product, whose other variants are still in it.
      if (options.variantGids) return null;
      const outcome = await removeCampaignTags(shopId, campaignId, client);
      return {
        messages:
          outcome.failed > 0
            ? [`${outcome.failed} product(s) kept their campaign tags — see the run for why.`]
            : [],
      };
    }

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
 * adding liveness reporting had made runs *less* reliable, and the worst case of a
 * missed stamp is a live run being reclaimed -- which the reaper's status guard
 * already makes safe.
 */
function heartbeat(runId: string, everyMs = 5_000) {
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
      failureReason:
        "Left as it is: this price was changed outside the app and you chose to keep that edit.",
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
async function priorLedger(campaignId: string, kind: "APPLY" | "REVERT") {
  const previous = await prisma.campaignRun.findFirst({
    where: { campaignId, kind },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!previous) return [];

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

async function recordResults(
  runId: string,
  shopId: string,
  rows: ExecutedRows,
): Promise<string[]> {
  const byStatus = new Map<"VERIFIED" | "APPLIED" | "FAILED" | "SKIPPED", string[]>();
  const messages: string[] = [];

  for (const executed of rows) {
    // A variant deleted mid-run is SKIPPED, not FAILED. Recording it as a failure
    // would make an ordinary merchant action look like a defect, and a run full of
    // "failures" nobody needs to act on is a run nobody reads (E4).
    const status =
      executed.status === "verified"
        ? "VERIFIED"
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
    await prisma.variantChange.updateMany({
      where: { runId, shopId, variantGid: { in: gids } },
      data: {
        status,
        appliedAt: status === "FAILED" ? null : now,
        verifiedAt: status === "VERIFIED" ? now : null,
      },
    });
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
        // Counts toward quarantine: a row that has burned its attempts is left alone
        // by the next resume rather than retried forever.
        attempt: { increment: 1 },
      },
    });
  }

  return messages;
}

/**
 * Updates the mirror for what we just wrote.
 *
 * Without this the dashboard's "not at baseline" count stays stale until the next
 * sync, which makes the app look wrong immediately after it did the right thing.
 */
async function refreshMirror(shopId: string, rows: ExecutedRows): Promise<void> {
  for (const executed of rows) {
    if (executed.status === "failed" || !executed.row.intendedPrice) continue;

    await prisma.priceSurfaceEntry.updateMany({
      where: {
        shopId,
        variantGid: executed.row.ref.variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
      },
      data: {
        livePrice: BigInt(executed.row.intendedPrice.amount),
        ...(executed.row.intendedCompareAtSet
          ? {
              liveCompareAt: executed.row.intendedCompareAt
                ? BigInt(executed.row.intendedCompareAt.amount)
                : null,
            }
          : {}),
        syncedAt: new Date(),
      },
    });
  }
}
