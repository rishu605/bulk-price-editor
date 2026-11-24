/**
 * A recapture from the recapture page: handed to the worker, and recorded on a row of its own
 * that the page follows (#1105, #808).
 *
 * The page always ran its recapture inline, which was fine while a recapture was database
 * work. Since #1071 a wholesale price is recaptured with its quantity ladder or not at all,
 * and since #704 that ladder is read from Shopify for the scope's variants, 25 prices a read,
 * one read after another: 10,000 wholesale prices is 400 reads and minutes of a request that
 * writes nothing until they are done. Past Railway's five minutes the merchant is shown a
 * "502" for a recapture still running -- or half-finished. And a recapture of a whole
 * catalogue is 102,132 baselines written in the web process's pool, where one shop's large
 * write takes every other shop's pages down with it (#803).
 *
 * So every recapture is the worker's (D29): a baseline capture never runs in a web request,
 * whatever its size. Every check the merchant's confirmation stands for is made first, in the
 * request, while they are looking; the worker makes them again before it writes, because
 * minutes may pass in between, and records a refusal where the page reads it. The row says
 * which step the recapture is on and how far that step has got, as the shop row does for a
 * sync (#801), and the page follows it there. The row is the truth and the job the doorbell:
 * with no worker queue, or Redis away, the worker's tick rings the row (`ringQueuedRecaptures`).
 *
 * One recapture per shop at a time, the page's inline ones included: two over the same
 * baselines collide on the one-current-baseline index part-way through, and one of them stops
 * half-written. Claimed through a partial unique index, so two presses cannot both win; one
 * that has gone quiet is closed when the next is claimed, so a dead worker never holds the
 * shop for good.
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import {
  quiet,
  RECAPTURE_STALE_AFTER_MS,
  recaptureStateOf,
  stepInSentence,
  type RecaptureOutcome,
  type RecapturePhase,
  type RecaptureProgress,
  type RecaptureState,
} from "../lib/baselines/recapture-progress";
import type { RecaptureScope } from "../lib/baselines/recapture-scope";
import { AppError } from "../lib/errors/app-error";
import type { AdminClient } from "../lib/execution/sync-executor";
import { countOf } from "../lib/format/display";
import { logger } from "../lib/logging/logger";
import { enqueueOrRun, type Handler, type QueueRuntime } from "../worker/queue-runtime.server";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";
import { reportError } from "./error-report.server";
import { ladderReadsToCapture } from "./flow/flow-capture.server";
import { checkRecapture, recaptureChecked, type RecaptureOptions, type RecapturePlan } from "./recapture.server";

/**
 * How often a running recapture says it is alive, and how often it records its count within
 * a step. An object, so a test can shorten them.
 */
export const recaptureTiming = { heartbeatMs: 30_000, progressMs: 2_000 };

/** What the recapture page asks for: the scope, and what the merchant confirmed it with. */
export interface PageRecapture extends RecaptureScope {
  confirmation: string;
  actor: string;
  /** The count the page showed beside the button (#716). */
  expectedScope: number;
}

export interface PageRecaptureAnswer {
  ok: boolean;
  message: string;
  /** Set when the worker has it: the recapture the page puts in its URL to follow. */
  recapture?: string;
}

/** The answer when the shop's one recapture is taken. */
export const ALREADY_RECAPTURING =
  "Another recapture is already running for this store, so nothing more was started. This page shows it as it goes; " +
  "check the scope again once it has finished, then recapture if you still need to.";

/**
 * How long the page waits for Redis to take a recapture's job: short, because the row is
 * written and the tick rings it (#808).
 */
const RECAPTURE_ENQUEUE_TIMEOUT_MS = 1_000;

/** How long a recapture may wait in `queued` before the tick rings it (#808). */
export const STRANDED_RECAPTURE_AFTER_MS = 15_000;

/**
 * What the recapture page's Replace does: check, then hand the recapture to the worker.
 *
 * Throws the check's `AppError` when the recapture is refused -- the phrase, the count, an
 * empty scope -- as `recapture` always has, so the page says it the way it always did.
 */
export async function recaptureFromPage(
  shopId: string,
  request: PageRecapture,
): Promise<PageRecaptureAnswer> {
  // Every check first, while the merchant is looking: a phrase mistyped or a count nobody was
  // shown is refused now, not minutes later in a worker they cannot see.
  const plan = await checkRecapture(shopId, request);
  // Counted for the log, as Flow counts them (#1092): what the worker will read from Shopify.
  const reads = await ladderReadsToCapture(shopId, plan.variantGids);

  const id = await claimRecapture(shopId, {
    segmentId: request.segmentId ?? null,
    stale: request.stale === true,
    scope: plan.scope,
    confirmation: request.confirmation,
    // The campaigns the merchant was warned about, by the plan they confirmed (#1105).
    confirmedOver: plan.overlaps.map((overlap) => overlap.campaignId),
    actor: request.actor,
    phase: "queued",
  });
  if (!id) return { ok: false, message: ALREADY_RECAPTURING };

  // The row is written, so nothing is lost if Redis does not take the job: the tick rings it.
  const queue = webQueue();
  try {
    if (queue) await enqueueWithin(queue, "sync", { shopId, recaptureId: id }, RECAPTURE_ENQUEUE_TIMEOUT_MS);
    else logger.warn("no worker queue: a recapture waits for the worker's tick", { shopId, recaptureId: id });
  } catch (error) {
    logger.warn("a recapture was not handed to the worker; its tick will ring it", {
      shopId,
      recaptureId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("a recapture was handed to the worker", { shopId, scope: plan.scope, ladderReads: reads });
  return {
    ok: true,
    recapture: id,
    message:
      `Recapturing ${countOf(plan.scope, "variant")} in the background. This page shows each step as it goes, and you can ` +
      "leave it: the recapture carries on without it.",
  };
}

/**
 * Rings every recapture left in `queued` past `STRANDED_RECAPTURE_AFTER_MS` (#808): one whose
 * job is still waiting is absorbed by its deduplication key, and one whose job never reached
 * Redis is queued now -- or run here, in the tick, by `inline` when the queue cannot take it.
 */
export async function ringQueuedRecaptures(
  queue: QueueRuntime,
  inline: Handler,
  { now = new Date(), shopId }: { now?: Date; shopId?: string } = {},
): Promise<number> {
  const rows = await prisma.baselineRecapture.findMany({
    where: {
      phase: "queued",
      finishedAt: null,
      startedAt: { lt: new Date(now.getTime() - STRANDED_RECAPTURE_AFTER_MS) },
      shop: { uninstalledAt: null },
      ...(shopId ? { shopId } : {}),
    },
    orderBy: { startedAt: "asc" },
    select: { id: true, shopId: true },
  });
  for (const row of rows) {
    try {
      await enqueueOrRun(queue, "sync", { shopId: row.shopId, recaptureId: row.id }, inline, RECAPTURE_ENQUEUE_TIMEOUT_MS);
    } catch (error) {
      logger.error("a queued recapture rung by the tick failed", {
        recaptureId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows.length;
}

/**
 * The worker's half: the recapture the page handed over, checked again and run (#1105).
 *
 * Every way it ends is recorded on its row, where the page following it reads it: what it
 * did, why it was refused, why it stopped. Nothing is thrown. A job the queue retried would
 * run a recapture the page has already said stopped, and whether to run it again -- over a
 * scope that may have moved -- is the merchant's to decide; the failure is reported for us.
 */
export async function runQueuedRecapture(shopId: string, recaptureId: string, client: AdminClient | null): Promise<void> {
  const row = await prisma.baselineRecapture.findFirst({ where: { id: recaptureId, shopId } });
  // A resent job, or one whose recapture was closed meanwhile: how it ended is recorded already.
  if (!row || row.finishedAt) return;

  // Picked up after the page had already said it was never started. Running it now would
  // make that untrue, and the merchant may have recaptured another way since.
  if (quiet(row)) {
    await finish(recaptureId, {});
    logger.warn("a queued recapture was not run: it waited longer than the page waits on it", {
      shopId,
      waitedMs: Date.now() - row.heartbeatAt.getTime(),
      staleAfterMs: RECAPTURE_STALE_AFTER_MS,
    });
    return;
  }

  // Only the worker that moves it out of the queue runs it: a job delivered twice runs once.
  const started = await prisma.baselineRecapture.updateMany({
    where: { id: recaptureId, finishedAt: null, phase: "queued" },
    data: { phase: "checking", heartbeatAt: new Date() },
  });
  if (started.count === 0) return;

  if (!client) {
    await finish(recaptureId, {
      failure:
        "The app has no working session for this store, so the quantity breaks of its wholesale prices could not be " +
        "read and nothing was recaptured. Open the app again from Shopify admin, then recapture.",
    });
    logger.warn("a queued recapture was not run: no usable session", { shopId });
    return;
  }

  try {
    await runClaimed(
      recaptureId,
      shopId,
      {
        ...(row.segmentId ? { segmentId: row.segmentId } : {}),
        stale: row.stale,
        confirmation: row.confirmation ?? "",
        actor: row.actor ?? undefined,
        expectedScope: row.scope,
        confirmedOver: row.confirmedOver,
      },
      client,
    );
  } catch (error) {
    const reported = await reportError(error, { shopId, route: "worker:recapture" });
    // The reference the page gives for a failure in its own request, so support can find it.
    if (reported.errorId) {
      await prisma.$executeRaw`
        UPDATE "baseline_recaptures" SET "failure" = "failure" || ${` Reference ${reported.errorId}.`}
        WHERE "id" = ${recaptureId} AND "failure" IS NOT NULL`;
    }
  }
}

/** What the page reads of a recapture's row. */
const ROW = {
  id: true,
  scope: true,
  phase: true,
  progress: true,
  heartbeatAt: true,
  finishedAt: true,
  outcome: true,
  failure: true,
} as const;

/**
 * The recapture the page is following, by the id in its URL, or the shop's own when it is
 * following none -- a recapture another tab started, or one this tab started before a reload.
 */
export async function recaptureOnPage(shopId: string, followed: string | null): Promise<RecaptureState | null> {
  const row =
    (followed ? await prisma.baselineRecapture.findFirst({ where: { id: followed, shopId }, select: ROW }) : null) ??
    (await prisma.baselineRecapture.findFirst({ where: { shopId, finishedAt: null }, select: ROW }));
  return row ? recaptureStateOf(row) : null;
}

/** One recapture's state, for the page polling it. Scoped to the shop in the query itself. */
export async function recaptureStatus(shop: { domain: string }, id: string): Promise<RecaptureState | null> {
  if (!id) return null;
  const row = await prisma.baselineRecapture.findFirst({ where: { id, shop: { domain: shop.domain } }, select: ROW });
  return row ? recaptureStateOf(row) : null;
}

/**
 * Claims the shop's one recapture, or returns null when another is running.
 *
 * The partial unique index is the guard, not a read beforehand, so two presses cannot both
 * win. A recapture that has gone quiet is closed first: its process is gone, and its row
 * already reads as stopped.
 */
async function claimRecapture(
  shopId: string,
  data: Omit<Prisma.BaselineRecaptureUncheckedCreateInput, "shopId" | "confirmedOver"> & { confirmedOver: string[] },
  now: Date = new Date(),
): Promise<string | null> {
  await prisma.baselineRecapture.updateMany({
    where: { shopId, finishedAt: null, heartbeatAt: { lt: new Date(now.getTime() - RECAPTURE_STALE_AFTER_MS) } },
    data: { finishedAt: now },
  });
  try {
    const row = await prisma.baselineRecapture.create({
      data: { ...data, shopId, startedAt: now, heartbeatAt: now },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") return null;
    throw error;
  }
}

/**
 * Runs a claimed recapture, recording each step on its row and how it ended. With a plan,
 * the page's own, checked a moment ago in the same request; without, the worker's, which
 * checks again first. Throws what stopped it, once that is recorded.
 */
async function runClaimed(
  id: string,
  shopId: string,
  options: RecaptureOptions,
  client: AdminClient,
  checked?: RecapturePlan,
) {
  const step = tracker(id);
  // Alive while this process is: one that dies stops stamping, which is what `quiet` is for.
  // Conditional on the row being open, so a late stamp cannot reopen a finished recapture.
  const alive = setInterval(() => {
    void prisma.baselineRecapture
      .updateMany({ where: { id, finishedAt: null }, data: { heartbeatAt: new Date() } })
      .catch(() => {});
  }, recaptureTiming.heartbeatMs);

  try {
    let plan = checked;
    if (!plan) {
      await step.track("checking");
      try {
        plan = await checkRecapture(shopId, options);
      } catch (error) {
        // Refused rather than failed -- the scope moved, a campaign went live -- and the
        // check's sentence already says what changed and what to do.
        if (error instanceof AppError && (error.code === "VALIDATION" || error.code === "NOT_FOUND")) {
          await finish(id, { failure: error.userMessage });
          logger.info("a queued recapture was refused when it was checked again", { shopId, reason: error.code });
        }
        throw error;
      }
    }

    const result = await recaptureChecked(shopId, plan, {
      ...options,
      client,
      onLadders: (done, total) => step.track("ladders", { done, total }),
      onProgress: (done, total) => step.track("baselines", { done, total }),
    });
    const outcome: RecaptureOutcome = {
      scope: plan.scope,
      captured: result.captured,
      superseded: result.superseded,
      alreadyCurrent: result.alreadyCurrent,
      wholesale: result.wholesale,
      wholesaleLeft: result.wholesaleLeft,
    };
    await finish(id, { outcome });
    return { ...result, scope: plan.scope, overlaps: plan.overlaps };
  } catch (error) {
    await finish(id, { failure: stoppedWhile(step.phase(), error) });
    throw error;
  } finally {
    clearInterval(alive);
  }
}

/** Why it stopped, in the step it was on: "The recapture stopped while recording baselines: …". */
function stoppedWhile(phase: RecapturePhase | null, error: unknown): string {
  const said = (error instanceof AppError ? error.userMessage : error instanceof Error ? error.message : String(error)).trim();
  const reason = /[.!?]$/.test(said) ? said : `${said}.`;
  const kept =
    phase === "baselines"
      ? "The baselines it recorded before it stopped are kept and the rest are as they were."
      : "Nothing was recaptured.";
  const where = phase ? ` while ${stepInSentence(phase)}` : "";
  return `The recapture stopped${where}: ${reason} ${kept} Check the scope again, then recapture.`;
}

/**
 * Ends the recapture, once: a second ending -- a refusal recorded, then the throw that carried
 * it -- leaves the first.
 */
async function finish(id: string, how: { outcome?: RecaptureOutcome; failure?: string }): Promise<void> {
  await prisma.baselineRecapture.updateMany({
    where: { id, finishedAt: null },
    data: {
      finishedAt: new Date(),
      ...(how.outcome ? { outcome: how.outcome as unknown as Prisma.InputJsonValue } : {}),
      ...(how.failure ? { failure: how.failure } : {}),
    },
  });
}

/**
 * Records the step and its count. A new step is written at once; a count within a step at
 * most every `progressMs`. Every write is also the heartbeat. A failed write never fails the
 * recapture: progress is a courtesy to the page.
 */
function tracker(id: string) {
  let current: RecapturePhase | null = null;
  let lastWrite = 0;
  return {
    phase: () => current,
    async track(phase: RecapturePhase, progress?: RecaptureProgress) {
      const now = Date.now();
      // A step's last count always lands, so the page never shows 9,975 of 10,000 for a step done.
      const last = progress !== undefined && progress.done >= progress.total;
      if (phase === current && now - lastWrite < recaptureTiming.progressMs && !last) return;
      current = phase;
      lastWrite = now;
      try {
        await prisma.baselineRecapture.updateMany({
          where: { id, finishedAt: null },
          data: {
            phase,
            progress: progress ? (progress as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            heartbeatAt: new Date(now),
          },
        });
      } catch (error) {
        logger.warn("could not record recapture progress", { id, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
