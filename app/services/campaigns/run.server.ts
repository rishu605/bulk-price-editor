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
import { isPractice, loadCampaignContext, scopeOf, importIdsOf} from "./model.server";
import { astToWhere } from "../segments.server";
import { AppError } from "../../lib/errors/app-error";
import { guardrailsFor } from "../settings.server";
import type { RunOutcome } from "./types";
import { transitionCampaign } from "./lifecycle.server";
import { planResume, type LedgerState } from "../../lib/execution/resume";
import { applyCampaignTags, removeCampaignTags } from "./tags.server";
import {
  applyMarketSurfaces,
  captureMarketBaselinesFirst,
  revertMarketSurfaces,
} from "./market-surfaces.server";
import { notify } from "../notifications.server";
import { metric } from "../../lib/telemetry/metrics";

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
      };
    }

    const refusal = await refusedByPlan(shopId, campaignId, options.variantGids?.length);
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
        refusedByPlan: refusal,
      };
    }
  }

  if (!options.variantGids) {
    await transitionCampaign(shopId, campaignId, options.revert ? "REVERTING" : "APPLYING", {
      reason: options.resume ? "resume requested" : options.revert ? "revert requested" : "apply requested",
    });
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
  const messagesBeforeExecution: string[] = [];

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
  if (!options.revert && !options.variantGids) {
    const baselineMessages = await captureMarketBaselinesFirst(
      shopId,
      campaignId,
      writable.map((row) => row.ref.variantGid),
      client,
    );
    messagesBeforeExecution.push(...baselineMessages);
  }

  const result = await executeRows(writable, {
    client,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: options.verifySampleRate ?? 1,
    onProgress: heartbeat(run.id),
  });

  const messages = await recordResults(run.id, shopId, result.rows);
  messages.unshift(...messagesBeforeExecution);

  // Tags after prices, deliberately. A badge on a product still showing full price is
  // worse than a price change nobody has badged yet, so the storefront never claims a
  // sale that has not landed.
  const tagOutcome = await syncTags(shopId, campaignId, run.id, writable, products, client, options);
  if (tagOutcome) messages.push(...tagOutcome.messages);

  // Markets, after the base surface. A campaign that only ever touched the base price
  // does nothing for a merchant selling into four markets — their EUR and JPY customers
  // see the old price for the whole sale. Failures here are reported and never fail the
  // run: the base prices already landed, and the ledger names every market row that did
  // not.
  try {
    const markets = options.variantGids
      ? // Scoped runs leave markets alone: one variant coming out of a sale does not
        // change what the other surfaces should show for the rest of them.
        []
      : options.revert
        ? await revertMarketSurfaces(shopId, campaignId, client)
        : await applyMarketSurfaces(
            shopId,
            campaignId,
            run.id,
            resolvable,
            writable.map((row) => row.ref.variantGid),
            client,
            storeGuardrails,
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

  await refreshMirror(shopId, result.rows);

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

/** Why the plan left rows alone, in the merchant's terms. */
const SKIP_REASONS: Record<string, string> = {
  "missing-cost": "have no cost recorded, and a cost-based guardrail applies",
  "missing-import": "were not in the imported file",
  "below-floor": "would have priced below a guardrail floor",
  "invalid-margin": "have a margin target that cannot be satisfied",
  "invalid-compare-at": "would have had a compare-at price below their price",
  "non-positive-price": "would have priced at or below zero",
};

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
 *
 * *Both* copies of the base live price, which is the part that was missing. The catalogue
 * index carries it for search and filtering; `price_surface_entries` carries it as one
 * uniform "live value on surface X" the resolver can read the same way for every surface.
 * Updating only the second left the first stale after every campaign — and the nightly
 * mirror audit compares against the first. A merchant who ran a sale over their whole
 * catalogue would have woken up to an alert saying the pipeline was systematically
 * broken, on the morning after it worked perfectly.
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

    await prisma.variantIndex.updateMany({
      where: { shopId, variantGid: executed.row.ref.variantGid },
      data: {
        price: BigInt(executed.row.intendedPrice.amount),
        ...(executed.row.intendedCompareAtSet
          ? {
              compareAt: executed.row.intendedCompareAt
                ? BigInt(executed.row.intendedCompareAt.amount)
                : null,
            }
          : {}),
        syncedAt: new Date(),
      },
    });
  }
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
        "products reverted": result.verified,
      });
      return;
    }

    await fireTriggerForShop(shopId, "campaign-started", {
      "campaign id": campaignId,
      "campaign name": campaignName,
      "products affected": outcome.counts.planned,
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
