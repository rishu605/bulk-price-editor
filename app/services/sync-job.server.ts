/**
 * A catalogue sync, run in the background and followed by the page that started it (#801).
 *
 * Syncing is the first thing a new store does and the biggest thing it ever does: read
 * the whole catalogue as a bulk operation, mirror every market's price list, then capture
 * a baseline for every surface. On a 102,132-variant store that took about twelve minutes,
 * all inside the request that the Home button made -- and Railway closes a silent request
 * at five. The merchant got a bare "502" while the sync carried on, then a page saying
 * "Not yet synced" for seven more minutes, offering two more sync buttons.
 *
 * So the button claims the sync and hands it to the worker; the worker records which step
 * it is on and how far that step has got, on the shop row; Home reads that, says what is
 * happening, and offers nothing to start a second one. A sync that stops leaves a sentence
 * saying where, and running it again picks up what is already captured -- every step is
 * idempotent over the mirror and the baselines.
 *
 * One sync per shop: claiming is a conditional update, so two presses cannot both start
 * one. A sync whose heartbeat has gone quiet for `SYNC_STALE_AFTER_MS` is treated as
 * stopped, so a worker that died mid-sync never leaves the button gone for good.
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { syncMessage } from "../lib/dashboard/sync-message";
import type { AdminClient } from "../lib/execution/sync-executor";
import { formatCount } from "../lib/format/display";
import { logger } from "../lib/logging/logger";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";
import { captureBaselines } from "./baselines.server";
import { syncCatalogViaBulk } from "./catalog-bulk-sync.server";
import { fetchShopBasics, syncCatalog, type GraphQLRunner } from "./catalog-sync.server";
import { syncMarkets } from "./markets-sync.server";
import { markSyncComplete } from "./shop.server";

/** How long a sync may go without a sign of life before it is treated as stopped. */
export const SYNC_STALE_AFTER_MS = 10 * 60_000;

/**
 * How often a running sync says it is alive, whatever step it is in. Every step that reports
 * progress stamps it too; this covers the ones that cannot -- the market read ran eight
 * minutes silent on a 102,132-variant store, two short of being taken for dead. An object,
 * so a test can shorten it.
 */
export const syncTiming = { heartbeatMs: 30_000 };

export type SyncPhase = "queued" | "catalogue" | "markets" | "baselines";

/** What Home says a sync is doing, step by step. */
export const PHASE_TEXT: Record<SyncPhase, string> = {
  queued: "Waiting for the background worker",
  catalogue: "Reading your catalogue from Shopify",
  markets: "Reading your markets' price lists",
  baselines: "Capturing baselines",
};

export interface SyncProgress {
  done: number;
  total?: number;
}

/** The sync as Home shows it. */
export interface SyncState {
  running: boolean;
  phase: SyncPhase | null;
  /** The phase in a sentence, with its count when there is one. */
  text: string | null;
  startedAt: string | null;
  /** Why the last sync stopped, when it did. */
  failure: string | null;
}

interface SyncColumns {
  syncStartedAt: Date | null;
  syncPhase: string | null;
  syncProgress: unknown;
  syncHeartbeatAt: Date | null;
  syncFailure: string | null;
}

/** The phase and its count in one sentence: "Capturing baselines: 59,132 of 102,132". */
export function describeSync(phase: SyncPhase, progress: SyncProgress | null): string {
  const base = PHASE_TEXT[phase];
  if (!progress || progress.done <= 0) return base;
  return progress.total
    ? `${base}: ${formatCount(progress.done)} of ${formatCount(progress.total)}`
    : `${base}: ${formatCount(progress.done)} variants so far`;
}

/**
 * The sync as of `now`, from the shop row.
 *
 * A sync that has gone quiet past `SYNC_STALE_AFTER_MS` is not running, whatever its row
 * says: its process stopped without recording it, and the honest thing to tell the
 * merchant is where it stopped and that running it again is safe.
 */
export function syncStateOf(shop: SyncColumns, now: Date = new Date()): SyncState {
  const phase = (shop.syncPhase ?? null) as SyncPhase | null;
  const lastSeen = shop.syncHeartbeatAt ?? shop.syncStartedAt;

  if (shop.syncStartedAt && phase && lastSeen && now.getTime() - lastSeen.getTime() <= SYNC_STALE_AFTER_MS) {
    return {
      running: true,
      phase,
      text: describeSync(phase, (shop.syncProgress ?? null) as SyncProgress | null),
      startedAt: shop.syncStartedAt.toISOString(),
      failure: null,
    };
  }

  const stopped =
    shop.syncStartedAt && phase
      ? `The last sync stopped responding while ${PHASE_TEXT[phase].toLowerCase()}. Run it again: it picks up what is already captured.`
      : null;
  return { running: false, phase: null, text: null, startedAt: null, failure: shop.syncFailure ?? stopped };
}

/**
 * Claims the shop's sync, or returns false when one is already running.
 *
 * A conditional update rather than a read then a write, so two presses cannot both win. A
 * claim that has gone stale is free to take: its process is gone.
 */
export async function claimSync(shopId: string, now: Date = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - SYNC_STALE_AFTER_MS);
  const claimed = await prisma.shop.updateMany({
    where: {
      id: shopId,
      OR: [{ syncStartedAt: null }, { syncHeartbeatAt: { lt: stale } }, { syncHeartbeatAt: null, syncStartedAt: { lt: stale } }],
    },
    data: { syncStartedAt: now, syncPhase: "queued", syncProgress: Prisma.DbNull, syncHeartbeatAt: now, syncFailure: null },
  });
  return claimed.count === 1;
}

/** Ends the sync, with the sentence saying why when it did not finish. */
async function releaseSync(shopId: string, failure: string | null): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: { syncStartedAt: null, syncPhase: null, syncProgress: Prisma.DbNull, syncHeartbeatAt: null, syncFailure: failure },
  });
}

/**
 * Records the step and its progress. A new step is written at once; progress within a step,
 * and a bare heartbeat, at most every few seconds. Every write is also the heartbeat, and a
 * heartbeat never clears the progress it has nothing to say about.
 */
function tracker(shopId: string, everyMs = 2_000) {
  let lastWrite = 0;
  let lastProgress = 0;
  return async (phase: SyncPhase, progress?: SyncProgress, newStep = false) => {
    const now = Date.now();
    if (!newStep && now - (progress ? lastProgress : lastWrite) < everyMs) return;
    lastWrite = now;
    // A new step's first count shows at once, not two seconds into it.
    lastProgress = progress ? now : newStep ? 0 : lastProgress;
    try {
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          syncPhase: phase,
          syncHeartbeatAt: new Date(now),
          // A new step starts with no count; `undefined` would leave the last step's.
          ...(progress || newStep ? { syncProgress: progress ? (progress as never) : Prisma.DbNull } : {}),
        },
      });
    } catch (error) {
      // Progress is a courtesy to the page; it never fails the sync.
      logger.warn("could not record sync progress", { shopId, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** The route-style GraphQL runner the catalogue reads take, over the worker's client. */
function runnerFor(client: AdminClient): GraphQLRunner {
  return {
    async graphql(query, options) {
      const response = await client.request(query, options?.variables ?? {});
      return { json: async () => response };
    },
  };
}

export interface SyncSummary {
  message: string;
  errors: string[];
}

/**
 * The whole sync: shop basics, the catalogue, the markets, the baselines, then the record
 * that it happened. Records each step on the shop row as it starts and as it goes, and
 * on failure says where it stopped. Called by the worker, or by the page when there is no
 * worker queue to hand it to.
 */
export async function runFullSync(shopId: string, client: AdminClient, actor: string): Promise<SyncSummary> {
  const track = tracker(shopId);
  const runner = runnerFor(client);
  let phase: SyncPhase = "catalogue";

  // Taken here as well as by the page, so a retried job, or a sync started by something
  // other than the button, still shows on Home.
  await prisma.shop.updateMany({ where: { id: shopId, syncStartedAt: null }, data: { syncStartedAt: new Date(), syncFailure: null } });

  // Alive while this process is: a worker that dies stops stamping, which is what the
  // stale rule is for. Conditional on the claim, so a late stamp cannot revive a sync that
  // has already ended.
  const alive = setInterval(() => {
    void prisma.shop
      .updateMany({ where: { id: shopId, syncStartedAt: { not: null } }, data: { syncHeartbeatAt: new Date() } })
      .catch(() => {});
  }, syncTiming.heartbeatMs);

  try {
    await track("catalogue", undefined, true);
    const basics = await fetchShopBasics(runner);
    await prisma.shop.update({
      where: { id: shopId },
      // Recorded at sync, because it answers "which plan applies": a development store gets
      // the top tier, and nothing else sets the flag.
      data: { timezone: basics.timezone, developerStore: basics.developerStore },
    });

    // Bulk first: one operation and a streamed result beats ten thousand paginated round
    // trips. Its poll sleeps are the heartbeat while Shopify builds the file.
    const bulk = await syncCatalogViaBulk(client, shopId, basics.currency, {
      onProgress: (progress) => track("catalogue", { done: progress.variants }),
      sleep: async (ms) => {
        await track("catalogue");
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    });
    // Falling back rather than failing: a shop already running a bulk operation still
    // deserves a sync, and on a small store the paginated path is what it is for.
    const catalogue =
      bulk.errors.length === 0 && bulk.written > 0
        ? { variants: bulk.written, products: bulk.products, errors: [] as string[] }
        : await syncCatalog(runner, shopId, basics.currency);

    // After the catalogue, never alongside it: one bulk operation per shop.
    phase = "markets";
    await track("markets", undefined, true);
    const markets = await syncMarkets(client, shopId);

    // Baselines at sync time: the only moment the live price can be taken to be the
    // merchant's normal one.
    phase = "baselines";
    await track("baselines", undefined, true);
    const capture = await captureBaselines(shopId, {
      onProgress: (done, total) => track("baselines", { done, total }),
    });

    await markSyncComplete(shopId);
    // A sync rewrites the mirror every price is computed against: it leaves a trace (#614).
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor,
        action: "catalogue.synced",
        entity: "Shop",
        entityId: shopId,
        after: {
          variants: catalogue.variants,
          products: catalogue.products,
          captured: capture.captured,
          priceLists: markets.priceLists,
        } as never,
      },
    });
    // Problems that did not stop the sync -- a market refused because a stranded bulk
    // record said an import was still running, a batch that would not write -- are said on
    // Home, as the banner after a sync used to say them (#733). The worker has nobody else
    // to tell.
    const errors = [...catalogue.errors, ...markets.errors];
    await releaseSync(
      shopId,
      errors.length > 0
        ? `The last sync finished, but ${errors.length === 1 ? "one part" : `${errors.length} parts`} did not: ${errors.slice(0, 3).join(" ")} Run it again to retry ${errors.length === 1 ? "it" : "them"}.`
        : null,
    );

    return {
      message: syncMessage({
        variants: catalogue.variants,
        products: catalogue.products,
        captured: capture.captured,
        alreadyCurrent: capture.alreadyCurrent,
        priceLists: markets.priceLists,
        relative: markets.relative,
        entries: markets.entries,
      }),
      errors,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await releaseSync(
      shopId,
      `The last sync stopped while ${PHASE_TEXT[phase].toLowerCase()}: ${reason} Run it again: it picks up what is already captured.`,
    );
    throw error;
  } finally {
    clearInterval(alive);
  }
}

/**
 * What the Sync button does: claim the sync and hand it to the worker, or say one is
 * already running. With no worker queue at all -- development without Redis -- it runs
 * here, as it always did.
 */
export async function startSync(
  shopId: string,
  client: AdminClient,
  actor: string,
): Promise<{ ok: boolean; message: string; errors: string[]; queued: boolean }> {
  if (!(await claimSync(shopId))) {
    return {
      ok: true,
      queued: true,
      message: "Your catalogue is already being synced. This page shows each step as it goes; nothing more was started.",
      errors: [],
    };
  }

  const queue = webQueue();
  if (!queue) {
    const summary = await runFullSync(shopId, client, actor);
    return { ok: summary.errors.length === 0, queued: false, message: summary.message, errors: summary.errors.slice(0, 5) };
  }

  try {
    await enqueueWithin(queue, "sync", { shopId, fullSync: true, actor });
  } catch (error) {
    await releaseSync(shopId, null);
    return {
      ok: false,
      queued: false,
      message:
        "The background worker could not be reached, so the sync did not start and nothing changed. Try again in a minute; " +
        "if it keeps happening, contact support from this page.",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  return {
    ok: true,
    queued: true,
    message:
      "Syncing your catalogue in the background. This page shows each step as it goes, and you can leave it: " +
      "the sync carries on without it.",
    errors: [],
  };
}
