/**
 * Run history and the per-row ledger.
 *
 * The forensic view: the bar is that support can trace any variant's complete price
 * story without opening a database client.
 */

import prisma from "../../db.server";
import { formatMinorUnits } from "../../lib/money/format";
import { titleMapFor } from "./candidates.server";
import type { LedgerRow, RunSummary } from "./types";

export async function campaignRuns(
  shopId: string,
  campaignId: string,
  limit = 20,
): Promise<RunSummary[]> {
  const runs = await prisma.campaignRun.findMany({
    where: { shopId, campaignId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return runs.map((run) => ({
    id: run.id,
    kind: run.kind,
    status: run.status,
    planned: run.plannedRows,
    verified: run.verifiedRows,
    failed: run.failedRows,
    skipped: run.skippedRows,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
}

/**
 * The per-row ledger for one run.
 *
 * Retention is unlimited on every tier, deliberately. Competitors sell 30/60/90-day
 * history as a paid axis; charging for the ability to explain what you did to
 * someone's prices is the wrong trade.
 */
export async function runLedger(
  shopId: string,
  runId: string,
  limit = 200,
): Promise<LedgerRow[]> {
  const changes = await prisma.variantChange.findMany({
    where: { shopId, runId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const titles = await titleMapFor(shopId, changes.map((c) => c.variantGid));

  return changes.map((change) => ({
    variantGid: change.variantGid,
    title: titles.get(change.variantGid) ?? change.variantGid,
    before: formatMinorUnits(change.beforePrice, change.currency),
    intended: formatMinorUnits(change.intendedPrice, change.currency),
    status: change.status,
    failureReason: change.failureReason,
  }));
}
