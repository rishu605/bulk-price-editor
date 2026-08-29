/**
 * What the newest run actually did, gathered in one place.
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

export async function runEvidence(
  shopId: string,
  selectedRunId: string | null,
): Promise<{
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
  if (!selectedRunId) return { ledger: [], ledgerTotal: 0, result: null };

  const [ledger, ledgerTotal, result] = await Promise.all([
    runLedger(shopId, selectedRunId),
    prisma.variantChange.count({ where: { shopId, runId: selectedRunId } }),
    campaignResult(shopId, selectedRunId),
  ]);

  return { ledger, ledgerTotal, result };
}
