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

export interface RunOptions {
  revert?: boolean;
  /**
   * Fraction of applied rows to read back. Defaults to full verification, which
   * suits the catalogue sizes the sync path handles; the bulk path gets per-row
   * confirmation from its result file instead.
   */
  verifySampleRate?: number;
}

export async function runCampaign(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const { resolvable, ast } = await loadCampaignContext(shopId, campaignId);
  const [candidates, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast),
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
  const writable = outcome.rows.filter((row) => row.status !== "skipped");

  const run = await prisma.campaignRun.create({
    data: {
      shopId,
      campaignId,
      kind,
      status: "EXECUTING",
      occurrenceKey: `${kind}-${Date.now()}`,
      plannedRows: outcome.counts.planned,
      startedAt: new Date(),
    },
  });

  await writeLedgerRows(run.id, shopId, writable);

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
  const result = await executeRows(outcome.rows, {
    client,
    productOf: (gid) => products.get(gid) ?? gid,
    verifySampleRate: options.verifySampleRate ?? 1,
  });

  const messages = await recordResults(run.id, shopId, result.rows);

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

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: options.revert ? "COMPLETED" : result.clean ? "ACTIVE" : "PARTIAL" },
  });

  await refreshMirror(shopId, result.rows);

  return {
    runId: run.id,
    planned: outcome.counts.planned,
    verified: result.verified,
    failed: result.failed,
    unverified: result.unverified,
    clean: result.clean,
    messages: messages.slice(0, 5),
  };
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
async function recordResults(
  runId: string,
  shopId: string,
  rows: ExecutedRows,
): Promise<string[]> {
  const byStatus = new Map<"VERIFIED" | "APPLIED" | "FAILED", string[]>();
  const messages: string[] = [];

  for (const executed of rows) {
    const status =
      executed.status === "verified"
        ? "VERIFIED"
        : executed.status === "failed"
          ? "FAILED"
          : "APPLIED";

    const bucket = byStatus.get(status) ?? [];
    bucket.push(executed.row.ref.variantGid);
    byStatus.set(status, bucket);

    if (executed.failureReason) messages.push(executed.failureReason);
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
      data: { failureReason: executed.failureReason },
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
