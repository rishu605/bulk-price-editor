/**
 * What `runEta` reads for a campaign whose run is writing (#820): the run row, one indexed
 * read, for the status route the campaign page polls every five seconds.
 *
 * **The heartbeat's count, not the ledger or the run's own counts.** Those are written at
 * the end: the run's counts when it finishes, and on the sync path its ledger rows in one
 * batch, once every product is written and read back. Part-way through a run neither had
 * moved, so an estimate read from them could only ever say nothing. The executor reports each
 * product it writes, and the heartbeat keeps that (`writtenRows` of `writableRows`).
 *
 * **The rows the executor writes, not `plannedRows`.** That is the whole plan's count, and a
 * resume writes only what the attempt it continues left (`planResume`). The prices a revert
 * keeps as edited (#1157) are never handed to the executor, so they are in neither count.
 * Counted as written, a revert keeping a tenth would open on a rate of a tenth in a second.
 */

import prisma from "../../db.server";
import { runEta } from "../../lib/campaigns/run-eta";

/** Run states with a process still behind them. */
const LIVE_RUN = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] as const;

export async function runEtaOf(shopId: string, campaignId: string, now = new Date()): Promise<string | null> {
  const run = await prisma.campaignRun.findFirst({
    where: { shopId, campaignId, status: { in: [...LIVE_RUN] } },
    orderBy: { createdAt: "desc" },
    select: { writePath: true, startedAt: true, heartbeatAt: true, writtenRows: true, writableRows: true },
  });
  if (!run) return null;

  // A run that has not written a price yet, or one from before the count was kept, has none.
  return runEta(
    {
      path: run.writePath,
      rows: run.writableRows ?? 0,
      written: run.writtenRows ?? 0,
      startedAt: run.startedAt,
      heartbeatAt: run.heartbeatAt,
    },
    now,
  );
}
