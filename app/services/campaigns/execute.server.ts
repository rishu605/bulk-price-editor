/**
 * Choosing and driving a write path.
 *
 * The planner decides sync or bulk; this module actually runs the chosen one and
 * normalises both into the same per-row result shape, so the caller records
 * outcomes identically either way.
 *
 * Both paths now verify the same way — by comparing the price Shopify reports against the
 * price the campaign intended. They did not always: the bulk path checked only for
 * `userError`s, which meant the largest campaigns got the weakest guarantee.
 *
 * Without this, a 1,615-row campaign would preview as "bulk" and then execute
 * synchronously -- roughly one variant every two seconds against a standard shop's
 * rate limit, which is not merely slow but infeasible.
 */

import {
  bulkOperationById,
  isTerminal,
  reconcileResults,
  submitBulkMutation,
  pollUntilTerminal,
  type BulkOperationState,
  type StagedTarget,
} from "../../lib/execution/bulk-executor";
import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import { isClampReason } from "../../lib/campaigns/clamp-reasons";
import { chunk } from "../../lib/db/chunk";
import { money } from "../../lib/money/money";
import { executeSync, type AdminClient, type ExecutedRow } from "../../lib/execution/sync-executor";
import { readBackRowVerdict } from "../../lib/execution/read-back";
import { classifyFailure } from "../../lib/execution/classify";
import type { PlannedRow } from "../../lib/planning/types";
import { selectWritePath } from "../../lib/planning/write-path";
import { RateLimitBudget } from "../../lib/shopify/budget";
import { metric } from "../../lib/telemetry/metrics";

export interface ExecuteOutcome {
  rows: ExecutedRow[];
  verified: number;
  failed: number;
  unverified: number;
  clean: boolean;
  path: "sync" | "bulk";
}

export interface ExecuteContext {
  client: AdminClient;
  /**
   * Whose rate-limit budget this run is spending.
   *
   * Carried only so `budget.saturation` can be reported per shop, which is the only way
   * the number means anything: saturation is a property of one merchant's bucket, and an
   * average across shops would hide the one that is exhausted behind the ones that are
   * idle. RFC §11 lists it as an SLO panel for that reason.
   */
  shopId: string;
  productOf: (variantGid: string) => string;
  verifySampleRate?: number;
  /** Overrides the automatic choice. Only used by tests and diagnostics. */
  forcePath?: "sync" | "bulk";
  /**
   * Liveness signal, called as work settles on either path.
   *
   * Both paths report it, and they have to: a bulk run spends almost all its time
   * waiting on a poll, so a heartbeat that only fired on sync writes would let the
   * reaper declare every long bulk run dead.
   */
  onProgress?: (done: number, total: number) => void | Promise<void>;
  /**
   * The bulk operation has been accepted by Shopify (#832). From here its rows may be
   * live whatever happens to this process, and the run has to say so.
   */
  onSubmitted?: (operation: BulkOperationState) => Promise<void>;
  /** Each poll of that operation, and its final state. */
  onPoll?: (operation: BulkOperationState) => void | Promise<void>;
  /** How long to wait for that operation before giving up on watching it. Tests only. */
  bulkWaitMs?: number;
}

/** Uploads a JSONL body to a staged target using multipart form data. */
async function uploadToStagedTarget(target: StagedTarget, body: string): Promise<void> {
  const form = new FormData();
  // Parameter order matters to the storage backend, and the file field must be last.
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([body], { type: "text/jsonl" }), "anchor-bulk.jsonl");

  const response = await fetch(target.url, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Staged upload failed: ${response.status} ${await response.text()}`);
  }
}

export async function executeRows(
  rows: PlannedRow[],
  context: ExecuteContext,
): Promise<ExecuteOutcome> {
  const writable = rows.filter((row) => row.status !== "skipped" && row.intendedPrice);
  const decision = selectWritePath(writable.length);
  const path = context.forcePath ?? decision.path;

  if (path === "sync") {
    const budget = new RateLimitBudget();
    const result = await executeSync(rows, {
      client: context.client,
      budget,
      productOf: context.productOf,
      verifySampleRate: context.verifySampleRate ?? 1,
      onProgress: context.onProgress,
    });

    // Reported after the run rather than during it: the interesting number is how much
    // of the merchant's bucket this campaign left behind, and sampling mid-run would
    // mostly record the sleep the budget manager had just finished taking.
    //
    // Only the sync path. The bulk path spends no rate-limit budget at all, so reporting
    // a saturation for it would draw a flat line that means "we did not look" while
    // reading as "nothing was used".
    const usable = budget.usableMaximum();
    if (usable > 0) {
      const saturation = Math.min(1, Math.max(0, 1 - budget.available() / usable));
      metric("budget.saturation", saturation, { shop: context.shopId });
    }

    return { ...result, path: "sync" };
  }

  return executeBulk(rows, writable, context);
}

/**
 * The bulk path.
 *
 * Absence is never treated as success: any row we submitted that the result file
 * does not mention stays unverified and is reported as such, rather than being
 * assumed to have worked. That asymmetry is what stops a half-applied campaign
 * being reported complete.
 */
async function executeBulk(
  allRows: PlannedRow[],
  writable: PlannedRow[],
  context: ExecuteContext,
): Promise<ExecuteOutcome> {
  const skipped: ExecutedRow[] = allRows
    .filter((row) => row.status === "skipped" || !row.intendedPrice)
    .map((row) => ({ row, status: "verified" as const }));

  const { operation, layout } = await submitBulkMutation(writable, {
    client: context.client,
    upload: uploadToStagedTarget,
    productOf: context.productOf,
  });
  await context.onSubmitted?.(operation);

  // The finish webhook is faster when it arrives, but it is documented to go
  // missing; polling is the fallback that stops a run hanging forever (E13).
  //
  // The heartbeat rides on the poll interval. A bulk operation is almost entirely
  // waiting, so this is the only place a long one can prove it is still alive --
  // without it the reaper would mistake every large run for a dead process.
  const finished = await pollUntilTerminal({
    client: context.client,
    onPoll: context.onPoll,
    timeoutMs: context.bulkWaitMs,
    sleep: async (ms) => {
      await context.onProgress?.(0, writable.length);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  });
  const finalState = finished ?? operation;

  // Shopify is still applying it and the wait is over. There is no result file to read,
  // and settling every row as "not present in the result file" let a resume send them all
  // again while Shopify was still writing them (#832). They stay sent; the campaign's next
  // run asks Shopify how the operation ended before it writes anything.
  if (!isTerminal(finalState.status)) {
    throw new AppError({
      code: "UNKNOWN",
      retryable: false,
      context: { operation: finalState.id, status: finalState.status, rows: writable.length },
      userMessage:
        `Shopify is still applying this campaign's ${writable.length} prices in bulk (operation ${finalState.id}), ` +
        "and the app has stopped waiting for it. They may already be live. The campaign's next run asks Shopify " +
        "how it ended before writing anything.",
    });
  }

  // Read against the lines that were sent. A product over 250 variants spans several, and a
  // userError's index is its place in one of them, not in the product (#985).
  const submittedGids = writable.map((row) => row.ref.variantGid);
  const { outcomes, unreported } = await reconcileResults(
    finalState,
    submittedGids,
    fetchResultFile,
    layout,
  );

  const unreportedSet = new Set(unreported);
  const executed: ExecutedRow[] = writable.map((row) => {
    const gid = row.ref.variantGid;

    if (unreportedSet.has(gid)) {
      return {
        row,
        status: "applied-unverified",
        failureReason:
          `Not present in the bulk result file (operation ${finalState.status}). ` +
          `Left unverified rather than assumed successful.`,
      };
    }

    const outcome = outcomes.get(gid);
    if (!outcome || !outcome.ok) {
      const reason = outcome?.failureReason ?? "Unknown failure";
      // A variant the merchant deleted while the run was in flight is skipped, as on the
      // sync path (E4, #1020): the same event reported two ways by two paths.
      const classified = classifyFailure(reason);
      if (outcome && classified.reason === "variant-deleted") {
        return { row, status: "skipped-deleted", failureReason: reason, guidance: classified.message };
      }
      return { row, status: "failed", failureReason: reason };
    }

    // The result file carries the price Shopify stored, and this used to throw it away —
    // marking a row verified because no `userError` came back. That is a claim about the
    // mutation, not about the storefront, and invariant I5 asks for the second one. The
    // comparison is free: no extra request, the number is already in hand.
    const verdict = readBackRowVerdict(
      row.intendedPrice,
      outcome.price,
      { set: row.intendedCompareAtSet, value: row.intendedCompareAt },
      outcome.compareAtPrice,
    );
    if (!verdict.ok) {
      return {
        row,
        status: "failed",
        failureReason: verdict.reason,
        observedPrice: verdict.observed,
      };
    }

    return { row, status: "verified", observedPrice: verdict.observed, remoteUpdatedAt: outcome.remoteUpdatedAt };
  });

  const rows = [...executed, ...skipped];
  const verified = rows.filter((r) => r.status === "verified").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const unverified = rows.filter((r) => r.status === "applied-unverified").length;

  return { rows, verified, failed, unverified, clean: failed === 0 && unverified === 0, path: "bulk" };
}

/** Streams a result file as text chunks so a large file is never fully buffered. */
async function* fetchResultFile(url: string): AsyncGenerator<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not fetch bulk results: ${response.status}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  yield decoder.decode();
}

/** A run in one of these has a process behind it. */
const LIVE_RUN: readonly string[] = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"];

/**
 * Before a run writes anything, asks Shopify how the campaign's last bulk operation ended
 * (#832). A run reclaimed or failed after Shopify accepted one leaves its rows WRITING:
 * sent, outcome unknown -- whether the operation was still running or had finished and its
 * result file was never read. Re-sending them blind would write prices that may already be
 * there, and calling them unchanged would be false.
 *
 * Still running: nothing writes, and the run says why. Finished: its result file settles
 * those rows -- verified, failed, or written but not reported -- exactly as the run would
 * have, and the run carries on with what is left. Returns the run whose rows it settled, so the
 * caller can bring that run's mirror and counts up to date, and the variants whose prices
 * landed: the run died before its tags and market prices, so the resume owes them both.
 */
export async function settleSubmittedBulk(
  shopId: string,
  campaignId: string,
  client: AdminClient,
): Promise<
  | { stillRunning: string }
  | { settledRunId: string; operation: string; landed: string[]; failed: number; unreported: number }
  | null
> {
  const record = await prisma.bulkOperationRecord.findFirst({
    where: { shopId, kind: "MUTATION", run: { campaignId, changes: { some: { status: "WRITING" } } } },
    orderBy: { submittedAt: "desc" },
    include: { run: { select: { status: true } } },
  });
  if (!record?.runId) return null;

  const stillRunning = (done: number | null) => ({
    stillRunning:
      `Shopify is still applying this campaign's prices in bulk (operation ${record.shopifyGid}` +
      `${done === null ? "" : `, ${done} done so far`}). Nothing was sent. Try again once it has finished.`,
  });

  // The run that sent it is alive and polling: its rows are its own to settle, one writer
  // per occurrence, and it will.
  if (record.run && LIVE_RUN.includes(record.run.status)) {
    return stillRunning(record.objectCount === null ? null : Number(record.objectCount));
  }

  const state = await bulkOperationById(client, record.shopifyGid);
  if (state && !isTerminal(state.status)) {
    const done = Number(state.objectCount ?? Number.NaN);
    await prisma.bulkOperationRecord.update({
      where: { id: record.id },
      data: { status: "RUNNING", lastPolledAt: new Date(), ...(Number.isFinite(done) ? { objectCount: BigInt(done) } : {}) },
    });
    return stillRunning(Number.isFinite(done) ? done : null);
  }

  const rows = await prisma.variantChange.findMany({
    where: { runId: record.runId, shopId, status: "WRITING" },
    select: {
      id: true,
      variantGid: true,
      intendedPrice: true,
      intendedCompareAt: true,
      intendedCompareAtSet: true,
      currency: true,
      failureReason: true,
    },
  });
  // Shopify no longer knows the operation: nothing can be read from it, so the rows are
  // what they were -- written, not read back -- and the resume writes them again.
  //
  // Read without the upload's layout, which died with the process that sent it: each line
  // is matched against the variants it reports. An error Shopify gives no variant for
  // leaves that row written-not-read-back, and the resume sends it again (#985).
  const finalState: BulkOperationState = state ?? { id: record.shopifyGid, status: "EXPIRED" };
  const { outcomes, unreported } = state
    ? await reconcileResults(finalState, rows.map((row) => row.variantGid), fetchResultFile)
    : { outcomes: new Map(), unreported: rows.map((row) => row.variantGid) };
  const missing = new Set(unreported);
  const now = new Date();

  // Recorded as `recordResults` would have recorded them, had the run lived: the same
  // statuses, stamps and failure bookkeeping. Grouped by outcome so 100,000 rows are a
  // few dozen statements, not 100,000; failures go one by one, as they do there, because
  // each carries its own reason and the price Shopify holds.
  const verified: string[] = [];
  const clamped: string[] = [];
  const landed: string[] = [];
  const unverified: string[] = [];
  const failed: Array<{ id: string; reason: string; observed?: bigint }> = [];
  const deleted: Array<{ id: string; reason: string }> = [];
  // Shopify's own timestamp for each landed write, for the mirror, as a live run records it (#932).
  const stamps = new Map<string, string[]>();
  for (const row of rows) {
    if (missing.has(row.variantGid)) {
      unverified.push(row.id);
      continue;
    }
    const outcome = outcomes.get(row.variantGid);
    const intended = row.intendedPrice === null ? undefined : money(Number(row.intendedPrice), row.currency);
    const compareAt = {
      set: row.intendedCompareAtSet,
      value: row.intendedCompareAt === null ? null : money(Number(row.intendedCompareAt), row.currency),
    };
    const verdict = outcome?.ok ? readBackRowVerdict(intended, outcome.price, compareAt, outcome.compareAtPrice) : null;
    if (verdict?.ok) {
      // The submit step wrote a clamped row's reason up front; nothing else tells them apart.
      (isClampReason(row.failureReason) ? clamped : verified).push(row.id);
      landed.push(row.variantGid);
      if (outcome?.remoteUpdatedAt) stamps.set(outcome.remoteUpdatedAt, [...(stamps.get(outcome.remoteUpdatedAt) ?? []), row.id]);
      continue;
    }
    // Deleted while the run was in flight: skipped, as the live paths record it (E4, #1020).
    if (outcome && !outcome.ok && classifyFailure(outcome.failureReason ?? "").reason === "variant-deleted") {
      deleted.push({ id: row.id, reason: outcome.failureReason ?? "" });
      continue;
    }
    failed.push(
      verdict && !verdict.ok
        ? { id: row.id, reason: verdict.reason, observed: verdict.observed ? BigInt(verdict.observed.amount) : undefined }
        : { id: row.id, reason: outcome?.failureReason ?? "Unknown failure" },
    );
  }

  const settle = (ids: string[], data: Parameters<typeof prisma.variantChange.updateMany>[0]["data"]) =>
    chunk(ids).map((batch) => prisma.variantChange.updateMany({ where: { id: { in: batch } }, data }));
  await prisma.$transaction([
    ...settle(verified, { status: "VERIFIED", appliedAt: now, verifiedAt: now }),
    ...settle(clamped, { status: "CLAMPED", appliedAt: now, verifiedAt: now }),
    ...[...stamps]
      .filter(([text]) => !Number.isNaN(new Date(text).getTime()))
      .flatMap(([text, ids]) => settle(ids, { remoteUpdatedAt: new Date(text) })),
    ...settle(unverified, {
      status: "APPLIED",
      appliedAt: now,
      failureReason: `Not present in the bulk result file (operation ${finalState.status}). Left unverified rather than assumed successful.`,
    }),
    ...deleted.map((row) =>
      prisma.variantChange.update({ where: { id: row.id }, data: { status: "SKIPPED", appliedAt: null, failureReason: row.reason } }),
    ),
    ...failed.map((row) =>
      prisma.variantChange.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          appliedAt: null,
          failureReason: row.reason,
          ...(row.observed !== undefined ? { appliedPrice: row.observed } : {}),
          // Counts toward quarantine, as a failure recorded by the run itself does.
          attempt: { increment: 1 },
        },
      }),
    ),
    prisma.bulkOperationRecord.update({
      where: { id: record.id },
      data: {
        status: finalState.status === "CREATED" || finalState.status === "RUNNING" ? "EXPIRED" : finalState.status,
        finishedAt: record.finishedAt ?? now,
        lastPolledAt: now,
        ...(finalState.url ? { resultUrl: finalState.url } : {}),
      },
    }),
  ]);
  return {
    settledRunId: record.runId,
    operation: record.shopifyGid,
    landed,
    failed: failed.length,
    unreported: unverified.length,
  };
}
