/**
 * A run handed to the worker: a row first, a job second (#772, #790, #808).
 *
 * Since D29 the web process writes only a run of at most `MAX_INLINE_ROWS` variants pressed
 * on the campaign page. Everything larger, and everything Flow starts, comes here: the
 * campaign is claimed and the run's QUEUED row written in one transaction (`claimForQueue`),
 * and only then is the worker asked for it. The request answers at once, and the campaign
 * page follows the row -- Queued, Planning, Writing N of M, Verifying -- until it finishes.
 *
 * **The row is the truth; the job is only the doorbell.** That is the shape #811 gave
 * webhooks, for the same reason. Redis can be away when the request asks (no Redis at all in
 * development, or an outage), or lose a job it took (restarted without its data). Before
 * this, the first refused the run -- "the background worker could not be reached" -- or ran
 * it inside the request after all, which is the very thing being avoided; the second left
 * the campaign Applying for good with nothing behind it. Now neither changes the answer: the
 * row says everything the job said (`request`), and the worker's tick rings any row left
 * waiting (`ringQueuedRuns`), running it there and then when its own queue cannot take it.
 *
 * **One live run per campaign, held by the database (#793).** `campaign_runs_one_live_run`
 * counts QUEUED, so a second press, a second tab or a Flow resend is refused by the index and
 * told which run holds the campaign. Only the worker that moves the row out of QUEUED runs it
 * (`adoptQueuedRun`), so a job rung twice runs once.
 */

import prisma from "../../db.server";
import { SCHEDULER_ACTOR } from "../../lib/audit/actor";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { logger } from "../../lib/logging/logger";
import { enqueueOrRun, type Handler, type QueueRuntime } from "../../worker/queue-runtime.server";
import { laneFor, type JobRef, type RunLane } from "../../worker/queues";
import { metric } from "../../lib/telemetry/metrics";
import { enqueueWithin, webQueue } from "../../worker/web-queue.server";
import { claimForQueue, releaseClaim } from "./lifecycle.server";
import { renewRunLease } from "../shop-lease.server";
import { clearQueuedRefused, recordQueuedRefused } from "./start-refusal.server";
import { queuedVerb } from "../../lib/campaigns/queued-refusal";
import type { RunOutcome } from "./types";

export interface QueuedRunOptions {
  revert: boolean;
  resume?: boolean;
  /** Who asked for it; carried to the worker's run (#746). */
  actor: string;
  /** The rollback report's "leave as it is" (#790): carried to the worker, never dropped. */
  skipVariantGids?: string[];
  skipReason?: string;
  /** Flow's End campaign (#794): the worker's run works out which prices are edited, and keeps them. */
  keepEdited?: boolean;
  /** An Apply pressed without the word, which the worker's run checks on its own plan (#812). */
  untypedPress?: boolean;
  /** The scope's size, as the budget counted it: the row's planned count until the worker plans. */
  scope: number;
  /** Whether it goes on the small-run lane (#809, `smallRun`), decided from the same count. */
  small?: boolean;
}

/** What a queued run was asked to do: on its row (`request`) and in its job. */
export interface QueuedRequest {
  revert: boolean;
  resume?: boolean;
  actor: string;
  /** The state the campaign was claimed from, so a run that ends before writing puts it back. */
  claimedFrom?: CampaignState;
  skipVariantGids?: string[];
  skipReason?: string;
  keepEdited?: boolean;
  untypedPress?: boolean;
  /**
   * On the small-run lane (#809). On the row so a ring puts it on the same lane as the press
   * did, and the deduplication key absorbs it there; absent on a row from before #809, which
   * goes on `execution` as every run did.
   */
  small?: boolean;
}

/**
 * How long the web process waits for Redis to take a queued run's job. Short, because nothing
 * is lost past it: the row is written, and the worker's tick rings it (#808). Flow's whole
 * wait is ten seconds, and the queue's own ten would have spent all of it.
 */
export const RUN_ENQUEUE_TIMEOUT_MS = 1_000;

/**
 * How long a run may wait in QUEUED before the tick rings it. A ring of a job still waiting is
 * absorbed by its deduplication key (`jobOptionsFor`), so this is short: it is how late a run
 * whose job never reached Redis starts, at worst one tick after it.
 */
export const STRANDED_RUN_AFTER_MS = 15_000;

const nothing = { runId: "", planned: 0, verified: 0, failed: 0, unverified: 0, clean: true };

/**
 * Claims the campaign, writes the run's QUEUED row and rings the worker, or returns null
 * when the campaign is already claimed or a live run holds it -- the caller then stands down
 * to that run, by name.
 *
 * Always answers "queued" once the row is written, whether or not Redis took the job: see
 * the note at the top. Throws, as a run does, when the move is not legal from where the
 * campaign is.
 */
export async function queueRun(
  shopId: string,
  campaignId: string,
  /** Why it is not written here, from `handedOver`: names the size and the reason. */
  reason: string,
  { revert, actor, resume, skipVariantGids, skipReason, keepEdited, untypedPress, scope, small }: QueuedRunOptions,
): Promise<RunOutcome | null> {
  // Everything the request would have run with. A revert that dropped the merchant's "leave
  // as it is" ticks on the way to the worker would overwrite the very edits they asked to
  // keep, and a resume that arrived as an apply would rewrite verified rows.
  const request: QueuedRequest = {
    revert,
    actor,
    ...(resume ? { resume } : {}),
    ...(skipVariantGids?.length ? { skipVariantGids, skipReason } : {}),
    ...(keepEdited && revert ? { keepEdited: true, skipReason } : {}),
    ...(untypedPress && !revert ? { untypedPress: true } : {}),
    ...(small ? { small: true } : {}),
  };

  const claim = await claimForQueue(
    shopId,
    campaignId,
    revert ? "REVERTING" : "APPLYING",
    { kind: revert ? "REVERT" : "APPLY", plannedRows: scope, request: { ...request } },
    { reason: `${revert ? "revert" : resume ? "resume" : "apply"} handed to the background worker: ${reason}`, actor },
  );
  if (!claim.claimed) return null;

  // A queued run refused earlier is no longer the latest word on this campaign (#1046): the
  // page reads this one's progress from now on, not that one's refusal.
  await clearQueuedRefused(campaignId);
  await ring(laneFor(small === true), jobFor({ id: claim.runId, shopId, campaignId, request: { ...request, claimedFrom: claim.from } }));

  const verb = revert ? "reverting" : "applying";
  return {
    ...nothing,
    runId: claim.runId,
    planned: scope,
    queued: true,
    messages: [
      `${reason} The background worker is ${verb} it, with no time limit: this page shows each step as it goes, ` +
        "and you can leave it. The Runs tab shows the result.",
    ],
  };
}

/**
 * The job a queued run's row stands for. Carries the request as well as the row's id: the
 * release before this one reads it from the job and knows no `runId` (see the migration).
 */
export function jobFor(row: { id: string; shopId: string; campaignId: string; request: unknown }): JobRef {
  const request = (row.request ?? {}) as Partial<QueuedRequest>;
  return {
    shopId: row.shopId,
    campaignId: row.campaignId,
    runId: row.id,
    revert: request.revert === true,
    ...(request.claimedFrom ? { claimedFrom: request.claimedFrom } : {}),
    ...(request.resume ? { resume: true } : {}),
    ...(request.actor ? { actor: request.actor } : {}),
    ...(request.skipVariantGids?.length ? { skipVariantGids: request.skipVariantGids, skipReason: request.skipReason } : {}),
    ...(request.keepEdited ? { keepEdited: true, skipReason: request.skipReason } : {}),
    ...(request.untypedPress ? { untypedPress: true } : {}),
  };
}

/** The lane a queued run's row names (#809): the small-run lane, or `execution`. */
export function laneOf(row: { request: unknown }): RunLane {
  return laneFor(((row.request ?? {}) as Partial<QueuedRequest>).small === true);
}

/** Asks the worker for a queued run, from the web process. Never throws: the row is the truth. */
async function ring(lane: RunLane, ref: JobRef): Promise<void> {
  const queue = webQueue();
  if (!queue) {
    // Development without Redis, or a deployment missing it: the worker's tick runs it.
    logger.warn("no worker queue: a queued run waits for the worker's tick", { shopId: ref.shopId, campaignId: ref.campaignId, runId: ref.runId });
    return;
  }
  try {
    await enqueueWithin(queue, lane, ref, RUN_ENQUEUE_TIMEOUT_MS);
  } catch (error) {
    logger.warn("a queued run was not handed to the worker; its tick will ring it", {
      shopId: ref.shopId,
      campaignId: ref.campaignId,
      runId: ref.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The worker's half of the doorbell (#808): rings every run left QUEUED past
 * `STRANDED_RUN_AFTER_MS`, oldest first. A run whose job is merely waiting is absorbed by its
 * deduplication key. One whose job never arrived is queued now -- or, when the queue cannot
 * take it either, run here, in the tick, by `inline`: that is what Redis being down degrades
 * to, in the worker and never in a request. Returns how many it rang.
 */
export async function ringQueuedRuns(
  queue: QueueRuntime,
  inline: Handler,
  { now = new Date(), shopId }: { now?: Date; shopId?: string } = {},
): Promise<number> {
  const rows = await prisma.campaignRun.findMany({
    where: {
      status: "QUEUED",
      createdAt: { lt: new Date(now.getTime() - STRANDED_RUN_AFTER_MS) },
      // An uninstalled shop's run waits for a reinstall: its job would only find no session.
      shop: { uninstalledAt: null },
      ...(shopId ? { shopId } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, shopId: true, campaignId: true, request: true },
  });
  for (const row of rows) {
    try {
      await enqueueOrRun(queue, laneOf(row), jobFor(row), inline, RUN_ENQUEUE_TIMEOUT_MS);
    } catch (error) {
      // The run's own failure handling has recorded what it could; one run must not stop the rest.
      logger.error("a queued run rung by the tick failed", {
        runId: row.id,
        campaignId: row.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows.length;
}

/**
 * The doorbell for a chunked run waiting for its next turn (#809, D34), the worker's tick's as
 * `ringQueuedRuns` is. Two things for each, every tick:
 *
 * - **Its shop's lease, renewed.** The run holds its shop from its first turn to its last, and
 *   between turns no process is there to renew it. Without this a run waiting longer than the
 *   lease lasts behind other shops' work would find another of its shop's runs writing when its
 *   turn came.
 * - **Its next turn, rung** once it has waited `STRANDED_RUN_AFTER_MS`. A turn still waiting in
 *   Redis absorbs the ring by the run's key; one Redis lost -- or that its worker never queued,
 *   because it died between ending its turn and asking for the next, or the reaper gave a dead
 *   turn back -- is queued now, or run here when the queue cannot take it, as a QUEUED run is.
 *
 * A turn rung here does not carry a scheduled start's campaign, so the end of a window that
 * closed while it wrote follows at the next tick, not in the same job (#1053). Returns how many
 * it rang.
 */
export async function ringChunkedRuns(
  queue: QueueRuntime,
  inline: Handler,
  { now = new Date(), shopId }: { now?: Date; shopId?: string } = {},
): Promise<number> {
  const waiting = await prisma.runChunk.findMany({
    where: {
      waitingSince: { not: null },
      // An uninstalled shop's run waits for a reinstall, as a QUEUED one does.
      run: { status: "EXECUTING", shop: { uninstalledAt: null }, ...(shopId ? { shopId } : {}) },
    },
    orderBy: { waitingSince: "asc" },
    select: { runId: true, waitingSince: true, run: { select: { shopId: true, campaignId: true } } },
  });
  let rung = 0;
  for (const row of waiting) {
    try {
      await renewRunLease(row.run.shopId, row.runId);
      if (row.waitingSince && row.waitingSince.getTime() > now.getTime() - STRANDED_RUN_AFTER_MS) continue;
      const ref: JobRef = { shopId: row.run.shopId, campaignId: row.run.campaignId, runId: row.runId, turn: true };
      // Always the large lane: a run of more than a chunk is never small (`smallRun`).
      await enqueueOrRun(queue, "execution", ref, inline, RUN_ENQUEUE_TIMEOUT_MS);
      rung++;
    } catch (error) {
      // One run must not stop the rest; its turn's own failure handling has said what it could.
      logger.error("a chunked run rung by the tick failed", {
        runId: row.runId,
        campaignId: row.run.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rung;
}

/**
 * Takes a queued run out of QUEUED for the worker that is about to run it, or returns false
 * when another already has -- a job rung twice, or delivered twice -- or the row is gone.
 * The heartbeat from here is the planning's (`runCampaign`), so the reaper sees it alive.
 */
export async function adoptQueuedRun(runId: string): Promise<boolean> {
  const adopted = await prisma.campaignRun.updateMany({
    where: { id: runId, status: "QUEUED" },
    data: { status: "PLANNING", heartbeatAt: new Date() },
  });
  if (adopted.count !== 1) return false;
  await reportRunWait(runId);
  return true;
}

/**
 * How long a run waited, from its press to the worker taking it, by lane and shop (#809):
 * whatever it waited for -- a slot, or the shop's own run before it, which `queue.wait_ms`
 * does not count. Best-effort: a metric never changes the run it describes.
 */
async function reportRunWait(runId: string): Promise<void> {
  try {
    const row = await prisma.campaignRun.findUnique({ where: { id: runId }, select: { shopId: true, createdAt: true, request: true } });
    if (!row) return;
    metric("run.wait_ms", Math.max(0, Date.now() - row.createdAt.getTime()), { lane: laneOf(row), shopId: row.shopId });
  } catch {
    // A metric is a description of work; failing to take it is not a reason to stop the work.
  }
}

/**
 * Closes a queued run that ended before it wrote anything: refused by a gate in the worker,
 * stood down to another writer, or stopped while planning. CANCELLED, never removed -- the run
 * history is the record, and nothing deletes from it -- and with no ledger, since rows are
 * written only once it is EXECUTING. Every reader of a campaign's latest whole run passes over
 * it, as it would a run that was never queued: Resume continues the run before it, and
 * auto-enrol does not take a revert that never started for one that is ending the sale (#805).
 * The reason is the campaign's history and `recordQueuedRefused`.
 *
 * Before the claim is given back, because `releaseClaim` refuses while a live run holds the
 * campaign, and this row is one until it is closed.
 */
export async function cancelUnstartedRun(runId: string): Promise<void> {
  await prisma.campaignRun.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "PLANNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

/**
 * A queued run the worker cannot start at all -- the store has no usable session -- given back
 * and said, rather than left for the tick to ring every thirty seconds into the same wall.
 * The merchant is told once, as for any queued run refused before it wrote (#1046).
 */
export async function refuseQueuedRun(ref: JobRef, reason: string): Promise<void> {
  if (!ref.runId || !ref.campaignId) return;
  // Only a row still waiting: one another worker has taken is that worker's to finish.
  const closed = await prisma.campaignRun.updateMany({
    where: { id: ref.runId, status: "QUEUED" },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  if (closed.count === 0) return;
  await recordQueuedRefused(ref.shopId, ref.campaignId, { verb: queuedVerb(ref), reason }, { tell: true });
  const to = ref.claimedFrom as CampaignState | undefined;
  if (to && to !== "APPLYING" && to !== "REVERTING") {
    await releaseClaim(ref.shopId, ref.campaignId, to, { reason, actor: ref.actor ?? SCHEDULER_ACTOR });
  }
}
