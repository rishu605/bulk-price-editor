/**
 * Reclaiming runs whose process died.
 *
 * A worker that is SIGKILLed -- crashed, OOM-killed, evicted mid-deploy -- cannot
 * report its own death. Its run stays EXECUTING and its campaign stays APPLYING, and
 * nothing in the system ever revisits either. The merchant sees "Applying..."
 * indefinitely, with prices half-changed on their storefront and no way to tell which
 * ones. That is the frozen-job failure this product exists to not have, and it is
 * what the chaos suite's worker-kill scenario found.
 *
 * The fix is liveness, not a timeout. A run stamps `heartbeatAt` as it works; the
 * scheduler reclaims any non-terminal run that has gone quiet for longer than the
 * threshold. A plain timeout on `startedAt` cannot work here -- a legitimate bulk run
 * over a large catalogue takes hours, and a timeout generous enough to survive it
 * would leave a genuinely dead run hanging for just as long.
 *
 * Reclaiming means marking the run PARTIAL and the campaign PARTIAL. Emphatically not
 * FAILED, and emphatically not rolling anything back: rows the dead process verified
 * really are live on the storefront, and its unfinished rows are still sitting in the
 * ledger as PENDING. PARTIAL is the honest description of that, and it is the state a
 * resume knows how to continue from.
 */

import prisma from "../../db.server";
import { logger } from "../../lib/logging/logger";
import { transitionCampaign } from "./lifecycle.server";

/**
 * How quiet a run must go before it is presumed dead.
 *
 * Comfortably more than the heartbeat interval, so a slow chunk or a long throttle
 * backoff is never mistaken for a corpse. Reclaiming a run that is merely slow would
 * be the worse error: two processes would then believe they own the same ledger.
 */
export const STALE_AFTER_MS = Number(
  process.env.RUN_STALE_AFTER_MS ?? 5 * 60_000,
);

/** Runs that have not finished and therefore have something left to reclaim. */
const NON_TERMINAL = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] as const;

export interface Liveness {
  heartbeatAt: Date | null;
  startedAt: Date | null;
}

/**
 * Whether a run has gone quiet long enough to be presumed dead.
 *
 * A function rather than a `where` clause so the boundaries are testable without a
 * database. They need to be: reclaiming a run that is merely slow is the worse of the
 * two errors -- two processes would then believe they own the same ledger -- so
 * "exactly at the threshold" has to resolve to alive, not dead.
 *
 * `startedAt` is the fallback for a run killed in the window between its row being
 * created and its first heartbeat landing, which is precisely where a crash on
 * startup falls. A run with neither timestamp has not started; leave it alone.
 */
export function isStale(
  run: Liveness,
  now: Date,
  staleAfterMs: number,
): boolean {
  const lastSeen = run.heartbeatAt ?? run.startedAt;
  if (!lastSeen) return false;
  return now.getTime() - lastSeen.getTime() > staleAfterMs;
}

export interface ReapResult {
  reclaimed: number;
  runIds: string[];
}

export async function reclaimStaleRuns(
  now: Date = new Date(),
  staleAfterMs: number = STALE_AFTER_MS,
): Promise<ReapResult> {
  // Fetched by status and filtered in code, rather than expressing the staleness rule
  // twice. The candidate set is every run currently in flight, which is small by
  // construction -- and if it ever is not, that unbounded growth is exactly the
  // condition this function exists to clear.
  const candidates = await prisma.campaignRun.findMany({
    where: { status: { in: [...NON_TERMINAL] } },
    select: {
      id: true,
      shopId: true,
      campaignId: true,
      kind: true,
      heartbeatAt: true,
      startedAt: true,
    },
  });

  const stale = candidates.filter((run) => isStale(run, now, staleAfterMs));

  const runIds: string[] = [];

  for (const run of stale) {
    try {
      // Counted from the ledger rather than trusted from the run row: the dead process
      // never got to write its own totals, so the row's counters are whatever they were
      // when it started.
      const [verified, failed, skipped] = await Promise.all([
        prisma.variantChange.count({
          where: { runId: run.id, status: "VERIFIED" },
        }),
        prisma.variantChange.count({
          where: { runId: run.id, status: "FAILED" },
        }),
        prisma.variantChange.count({
          where: { runId: run.id, status: "SKIPPED" },
        }),
      ]);

      // Guarded on status: if the process was merely slow and has since finished, this
      // updates nothing rather than dragging a completed run back to PARTIAL.
      const updated = await prisma.campaignRun.updateMany({
        where: { id: run.id, status: { in: [...NON_TERMINAL] } },
        data: {
          status: "PARTIAL",
          verifiedRows: verified,
          failedRows: failed,
          skippedRows: skipped,
          finishedAt: now,
        },
      });
      if (updated.count === 0) continue;

      // Rows the dead process had claimed but never settled. Back to PENDING so a
      // resume treats them as outstanding work; leaving them WRITING would have them
      // read as in-flight forever by a process that no longer exists.
      await prisma.variantChange.updateMany({
        where: { runId: run.id, status: "WRITING" },
        data: { status: "PENDING" },
      });

      // Best-effort, and deliberately after the run is already reclaimed. A campaign
      // cancelled while its run was in flight cannot legally move to PARTIAL, and an
      // exception here would abort the whole sweep -- one dead run on one cancelled
      // campaign would stop the scheduler from doing anything for every shop.
      try {
        await transitionCampaign(run.shopId, run.campaignId, "PARTIAL", {
          reason:
            `Run ${run.id} stopped responding and was reclaimed. ` +
            `${verified} rows verified before it stopped; the rest are unchanged and can be resumed.`,
          runId: run.id,
        });
      } catch (error) {
        logger.warn("reclaimed a run but could not move its campaign", {
          runId: run.id,
          campaignId: run.campaignId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.warn("reclaimed stale run", {
        runId: run.id,
        campaignId: run.campaignId,
        kind: run.kind,
        verified,
        failed,
        quietForMs: run.heartbeatAt
          ? now.getTime() - run.heartbeatAt.getTime()
          : null,
      });

      runIds.push(run.id);
    } catch (error) {
      // One unreclaimable run must not leave every other one hanging. The next sweep
      // tries again; the run stays stale until it succeeds, which is the safe way to
      // be wrong here.
      logger.error("could not reclaim stale run", {
        runId: run.id,
        campaignId: run.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { reclaimed: runIds.length, runIds };
}
