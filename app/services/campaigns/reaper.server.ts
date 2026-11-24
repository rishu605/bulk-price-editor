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

import { SCHEDULER_ACTOR } from "../../lib/audit/actor";
import prisma from "../../db.server";
import { logger } from "../../lib/logging/logger";
import { countOf } from "../../lib/format/display";
import { transitionCampaign } from "./lifecycle.server";
import { settleMirror } from "./mirror.server";
import { LANDED } from "../../lib/execution/landed";

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

/**
 * How often a working run stamps its heartbeat: a tenth of the threshold, and never less
 * often than every five seconds. Derived rather than set beside it, so the two cannot
 * drift into a heartbeat slower than the reaper's patience -- ten missed beats, not one,
 * is what it takes to be presumed dead.
 */
export const HEARTBEAT_EVERY_MS = Math.min(5_000, Math.floor(STALE_AFTER_MS / 10));

/** Runs that have not finished and therefore have something left to reclaim. */
const NON_TERMINAL = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] as const;

/**
 * The ones with a process behind them, which can die. A QUEUED run has none yet: it is a row
 * waiting for the worker (#808), however long that takes, and the tick rings it rather than
 * reclaiming it (`ringQueuedRuns`). Reclaimed, a run waiting behind another shop's would read
 * Partial with nothing written, and its job would then find nothing to run.
 */
const RECLAIMABLE = ["PLANNING", "EXECUTING", "VERIFYING"] as const;

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

/** The later of two instants, either of which may be missing. */
function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * When this run last wrote anything to its ledger: a price or tag row created, applied or
 * verified. Only ever asked about a run that has already gone quiet, which is a handful at
 * most.
 */
async function lastLedgerActivity(runId: string): Promise<Date | null> {
  const [prices, tags] = await Promise.all([
    prisma.variantChange.aggregate({
      where: { runId },
      _max: { createdAt: true, appliedAt: true, verifiedAt: true },
    }),
    prisma.tagChange.aggregate({
      where: { runId },
      _max: { createdAt: true, appliedAt: true, verifiedAt: true },
    }),
  ]);
  return [...Object.values(prices._max), ...Object.values(tags._max)].reduce<Date | null>(
    (acc, at) => latest(acc, at ?? null),
    null,
  );
}

export interface ReapResult {
  reclaimed: number;
  runIds: string[];
}

export async function reclaimStaleRuns(
  now: Date = new Date(),
  staleAfterMs: number = STALE_AFTER_MS,
  /**
   * One shop only (#1069). The scheduler sweeps every shop; a chaos scenario sweeping with a
   * short staleness, or an hour ahead, sweeps its own fixture, or it reclaims whatever other
   * scenario shares the database -- Partial mid-run, with nothing wrong.
   */
  scope: { shopId?: string } = {},
): Promise<ReapResult> {
  // Fetched by status and filtered in code, rather than expressing the staleness rule
  // twice. The candidate set is every run currently in flight, which is small by
  // construction -- and if it ever is not, that unbounded growth is exactly the
  // condition this function exists to clear.
  const candidates = await prisma.campaignRun.findMany({
    where: { status: { in: [...RECLAIMABLE] }, ...(scope.shopId ? { shopId: scope.shopId } : {}) },
    select: {
      id: true,
      shopId: true,
      campaignId: true,
      kind: true,
      heartbeatAt: true,
      startedAt: true,
    },
  });

  const quiet = candidates.filter((run) => isStale(run, now, staleAfterMs));

  const runIds: string[] = [];

  for (const run of quiet) {
    try {
      // The heartbeat is one signal; the run's own ledger is another, and the one that
      // cannot be forgotten by a phase that writes. A run whose price or tag rows are still
      // being written is alive however quiet its heartbeat, and reclaiming it showed the
      // merchant Partial and a Resume button while it was writing (#791).
      const activity = await lastLedgerActivity(run.id);
      if (!isStale({ ...run, heartbeatAt: latest(run.heartbeatAt, activity) }, now, staleAfterMs)) {
        logger.info("quiet run left alone: its ledger is still changing", { runId: run.id, campaignId: run.campaignId });
        continue;
      }

      // Counted from the ledger rather than trusted from the run row: the dead process
      // never got to write its own totals, so the row's counters are whatever they were
      // when it started.
      const [verified, failed, skipped] = await Promise.all([
        prisma.variantChange.count({
          where: { runId: run.id, status: { in: [...LANDED] } },
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
      //
      // Except rows inside a bulk operation Shopify accepted (#832): Shopify goes on
      // applying those after the process that sent them stops watching, so they are sent,
      // not unsent, and stay WRITING until the campaign's next run asks Shopify how the
      // operation ended. Finished or not: a process that dies reading a 100,000-row result
      // file leaves an operation that is done and rows nobody has read back.
      const operation = await prisma.bulkOperationRecord.findFirst({
        where: { runId: run.id, kind: "MUTATION" },
        orderBy: { submittedAt: "desc" },
        select: { shopifyGid: true, status: true },
      });
      const sent = operation ? await prisma.variantChange.count({ where: { runId: run.id, status: "WRITING" } }) : 0;
      if (!operation) {
        await prisma.variantChange.updateMany({
          where: { runId: run.id, status: "WRITING" },
          data: { status: "PENDING" },
        });
      }

      // The mirror, from the ledger, as a run that throws settles it (#903). Only a run
      // that finishes refreshed it, so a reclaimed run left every variant it had written
      // reading its pre-run price -- and a Revert from Partial planned those as already at
      // baseline, wrote nothing for them, and reported clean with the sale still live.
      await settleMirror(run.id);

      // Best-effort, and deliberately after the run is already reclaimed. A campaign
      // cancelled while its run was in flight cannot legally move to PARTIAL, and an
      // exception here would abort the whole sweep -- one dead run on one cancelled
      // campaign would stop the scheduler from doing anything for every shop.
      try {
        await transitionCampaign(run.shopId, run.campaignId, "PARTIAL", {
          actor: SCHEDULER_ACTOR,
          reason: operation && sent > 0
            ? `Run ${run.id} stopped responding and was reclaimed ` +
              (operation.status === "CREATED" || operation.status === "RUNNING"
                ? `while Shopify was still running its bulk operation ${operation.shopifyGid}. `
                : `after Shopify finished its bulk operation ${operation.shopifyGid}, before its results were read. `) +
              `${countOf(sent, "price")} ${sent === 1 ? "was" : "were"} sent to Shopify and may already be live; ` +
              `${countOf(verified, "row")} ${verified === 1 ? "was" : "were"} verified before it stopped. Resume asks Shopify how that operation ended ` +
              `before sending anything again.`
            : `Run ${run.id} stopped responding and was reclaimed. ` +
              `${countOf(verified, "row")} verified before it stopped; the rest are unchanged and can be resumed.`,
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
