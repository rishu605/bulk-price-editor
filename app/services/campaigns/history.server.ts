/**
 * Run history and the per-row ledger.
 *
 * The forensic view: the bar is that support can trace any variant's complete price
 * story without opening a database client.
 */

import prisma from "../../db.server";
import { labelled, priceListLabel } from "../../lib/markets/display-name";
import { ROWS_PER_VIEW } from "../../lib/ui/table-budget";
import { formatMinorUnits } from "../../lib/money/format";
import { runEmailLine } from "../../lib/notifications/delivery";
import { deliveriesByRun, mailConfigured } from "../notifications.server";
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
  // Each run's email is recorded after the run row, so the oldest run shown bounds them all.
  // None at all while this deployment cannot send email: the app does not offer email then,
  // so a run has nothing to say about one, and the column is not shown.
  const emailing = mailConfigured();
  const oldest = runs.at(-1)?.createdAt;
  const emails = emailing && oldest ? await deliveriesByRun(shopId, campaignId, oldest) : new Map();

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
    ...(emailing ? { email: runEmailLine(emails.get(run.id)) } : {}),
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
  /** Rows to return; null for every row, which is what an export reads (#819). */
  limit: number | null = ROWS_PER_VIEW * 4,
): Promise<LedgerRow[]> {
  const changes = await prisma.variantChange.findMany({
    where: { shopId, runId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...(limit === null ? {} : { take: limit }),
  });

  const titles = await titleMapFor(shopId, changes.map((c) => c.variantGid));
  const listGids = [...new Set(changes.map((c) => c.priceListGid).filter(Boolean))];
  const lists = listGids.length
    ? await prisma.priceListRecord
        .findMany({
          where: { shopId, priceListGid: { in: listGids } },
          select: { priceListGid: true, name: true, catalogTitle: true, surfaceKind: true },
        })
        .then((rows) => rows.map(labelled))
    : [];
  const listBy = new Map(lists.map((list) => [list.priceListGid, list]));

  return changes.map((change) => ({
    variantGid: change.variantGid,
    title: titles.get(change.variantGid) ?? change.variantGid,
    surface: change.priceListGid
      ? (listBy.get(change.priceListGid)?.name ?? priceListLabel({ name: "", surfaceKind: change.surfaceKind }))
      : "Base price",
    currency: change.currency,
    priceListGid: change.priceListGid,
    before: formatMinorUnits(change.beforePrice, change.currency),
    intended: formatMinorUnits(change.intendedPrice, change.currency),
    status: change.status,
    failureReason: change.failureReason,
  }));
}
