/**
 * What one run of this campaign actually did, gathered in one place.
 *
 * Three reads that are only ever wanted together — the ledger rows, how many rows there
 * are in total, and the run's own outcome — and which are meaningless apart: a ledger
 * page with no total reads as the whole record, and an outcome with no ledger is a
 * summary of evidence nobody can see.
 *
 * The distinction the campaign page turns on lives here too. The preview is the
 * *intention*; the ledger is the *evidence*, and a partial run is exactly where the two
 * stop agreeing. Anything that presents one as the other is the failure this app exists
 * to prevent, so they are fetched by different code and never merged.
 */

import prisma from "../../db.server";
import { runLedger } from "./history.server";
import { campaignResult } from "./result.server";

/** Which run the ledger is showing, so the page can say so. */
export interface LedgerRun {
  id: string;
  kind: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export async function runEvidence(
  shopId: string,
  campaignId: string,
  /** `?run=` from the URL: a request, not a fact. Null for the newest run. */
  requestedRunId: string | null,
): Promise<{
  /** The run actually shown: the one asked for if it is this campaign's, else the newest. */
  selectedRunId: string | null;
  ledgerRun: LedgerRun | null;
  ledger: Awaited<ReturnType<typeof runLedger>>;
  /**
   * How many rows that run wrote in total, so the table can say what it is not showing.
   *
   * The ledger is capped — `s-table` blanks the page past a few hundred cells — and a
   * capped table that says nothing reads as the whole record, on the one screen whose
   * entire job is being the record.
   */
  ledgerTotal: number;
  result: Awaited<ReturnType<typeof campaignResult>> | null;
}> {
  // The run is looked up under this campaign, never by id alone (#764). The page took
  // `?run=` as given and the ledger read it by shop, so `/app/campaigns/A?run=<a run of B>`
  // drew B's ledger under A's name -- and its Revert this variant buttons posted B's
  // variants to A, which excluded them from A for good. A run that is not this campaign's
  // is treated as no request at all: the newest run is shown, as it is with no `?run=`.
  const run =
    (requestedRunId ? await runOf(shopId, campaignId, requestedRunId) : null) ??
    (await runOf(shopId, campaignId, null));

  if (!run) return { selectedRunId: null, ledgerRun: null, ledger: [], ledgerTotal: 0, result: null };

  const [ledger, ledgerTotal, result] = await Promise.all([
    runLedger(shopId, run.id),
    prisma.variantChange.count({ where: { shopId, runId: run.id } }),
    campaignResult(shopId, run.id),
  ]);

  return {
    selectedRunId: run.id,
    ledgerRun: {
      id: run.id,
      kind: run.kind,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
    },
    ledger,
    ledgerTotal,
    result,
  };
}

/** One of this campaign's runs: the one named, or the newest -- in `campaignRuns`' order. */
function runOf(shopId: string, campaignId: string, runId: string | null) {
  return prisma.campaignRun.findFirst({
    where: { shopId, campaignId, ...(runId ? { id: runId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, startedAt: true, finishedAt: true, createdAt: true },
  });
}
