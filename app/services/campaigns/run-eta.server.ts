/**
 * What `runEta` reads for a campaign whose run is writing (#820): the run, and its base
 * prices' rows in the ledger.
 *
 * Asked by the status route the campaign page polls every five seconds, so it reads as
 * little as it can: the run, one indexed read, and its ledger only on the sync path, the one
 * path whose rate can be observed, and which a run over the bulk threshold never takes.
 *
 * **The ledger, not the run row.** The run's own counts are written once, at its end.
 *
 * **The rows it writes, not `plannedRows`.** That is the whole plan's count, and a resume
 * writes only what the attempt it continues left (`planResume`). The prices a revert leaves
 * as edited are ledgered SKIPPED as it starts (#1157), settled before any price is sent.
 * Counted as written, a revert keeping a tenth would open on a rate of a tenth in a few
 * seconds and say it was nearly done. They are neither written nor to write.
 *
 * **Silent on today's run path.** The sync path settles its base rows in one batch, once
 * every product is written and read back (`recordResults`), so the ledger reads nothing
 * written and then every row written. The first is under 5% and the second is past 100%,
 * and the line says nothing either side. It speaks once a run records its rows as it
 * writes them, a change to the run path left for later (D28).
 */

import prisma from "../../db.server";
import { runEta } from "../../lib/campaigns/run-eta";
import { tallyStatuses } from "../../lib/campaigns/run-result";

/** Run states with a process still behind them. */
const LIVE_RUN = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] as const;

export async function runEtaOf(shopId: string, campaignId: string, now = new Date()): Promise<string | null> {
  const run = await prisma.campaignRun.findFirst({
    where: { shopId, campaignId, status: { in: [...LIVE_RUN] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, writePath: true, startedAt: true, heartbeatAt: true },
  });
  if (!run) return null;

  // `runEta` gives a bulk operation, or a run yet to choose, no estimate, so their ledger
  // (up to 102,132 rows sent to Shopify) is not counted every five seconds to learn that.
  const counts =
    run.writePath === "SYNC"
      ? tallyStatuses(
          (
            await prisma.variantChange.groupBy({
              by: ["status"],
              where: { shopId, runId: run.id, surfaceKind: "BASE", priceListGid: "" },
              _count: { _all: true },
            })
          ).map((group) => ({ status: group.status, count: group._count._all })),
        )
      : null;
  const written = counts ? counts.verified + counts.clamped + counts.unverified + counts.failed : 0;

  return runEta(
    {
      path: run.writePath,
      rows: counts ? written + counts.pending + counts.sent : 0,
      written,
      startedAt: run.startedAt,
      heartbeatAt: run.heartbeatAt,
    },
    now,
  );
}
