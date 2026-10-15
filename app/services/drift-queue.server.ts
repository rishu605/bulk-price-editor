/**
 * The drift queue at volume (#822): filtered, counted, exported, and decided many at once.
 *
 * The queue showed fifteen drifted prices with one decision each, so 1,113 of them -- a
 * merchant's own bulk edit, a CSV import in the Shopify admin, another app repricing
 * during a sale -- were 1,113 clicks while the campaign stayed Held. This filters the queue
 * by campaign, product and direction, counts what matches against the true total, and
 * applies one confirmed decision to everything that matches:
 *
 * - **Keep** and **leave** are database work: each event is claimed with one conditional
 *   update, so no event is decided twice whoever else is deciding it, and "keep" writes
 *   the new baselines in the same transaction as the claim.
 * - **Put back** is a write, so it is a run (rule 2): one run for the campaign over every
 *   variant in the set, through `runCampaign` and its claim on `campaign_runs`, with an
 *   occurrence key derived from the decision so a second copy of it defers rather than
 *   writing twice.
 *
 * Over `DRIFT_INLINE_ROWS`, or past the page's time budget for a put-back, the decision is
 * handed to the worker (#808) and the page follows it. Either way it is audit-logged as
 * one entry naming every variant it resolved.
 */

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { adoptBaselines } from "./baseline-adopt.server";
import {
  describeBatch,
  describeDriftFilters,
  doing,
  DRIFT_INLINE_ROWS,
  formatBatchParam,
  prices,
  type BatchProgress,
  type BatchRef,
  type BatchSummary,
  type DriftChoice,
  type DriftFilters,
} from "../lib/drift/batch";
import { chunk } from "../lib/db/chunk";
import { toAppError } from "../lib/errors/app-error";
import { estimateMs, overBudget, PAGE_INLINE_BUDGET_MS } from "../lib/execution/inline-budget";
import type { AdminClient } from "../lib/execution/sync-executor";
import { LANDED } from "../lib/execution/landed";
import { formatCount } from "../lib/format/display";
import { logger } from "../lib/logging/logger";
import { DEFAULT_THRESHOLD } from "../lib/planning/write-path";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";
import { releaseHold } from "./campaigns/lifecycle.server";
import { driftRowsFor, type DriftRow } from "./drift.server";

/** States a campaign can be put back from: running, and not mid-run. The single put-back's. */
const REASSERTABLE = new Set(["ACTIVE", "HELD", "PARTIAL"]);

/** Events a statement claims at once: one transaction each, well inside its timeout. */
const CLAIM_CHUNK = 500;

/** Whom one bulk decision covers: a campaign, the product and direction filters, and when. */
export interface DriftBatch {
  campaignId: string;
  resolution: DriftChoice;
  q?: string;
  direction?: DriftFilters["direction"];
  /** When the page that confirmed it was loaded. An edit after this is not in the decision. */
  asOf: string;
}

// ------------------------------------------------------------------------- reading

/**
 * Pending events matching the filters, as `FROM ... WHERE`.
 *
 * Raw rather than through the client because a product filter is a search of the variant
 * index, which has no relation to drift events, and joining in SQL is the only way to do
 * it without a list of every matching variant in one `IN` -- which, for a search that
 * matches most of a 100,000-variant catalogue, Postgres refuses outright.
 */
function selection(shopId: string, filters: DriftFilters, asOf?: string): Prisma.Sql {
  const conditions = [Prisma.sql`d."shopId" = ${shopId}`, Prisma.sql`d."resolution" = 'PENDING'`];
  if (filters.campaignId) conditions.push(Prisma.sql`d."campaignId" = ${filters.campaignId}`);
  if (filters.direction === "up") conditions.push(Prisma.sql`d."observedPrice" > d."expectedPrice"`);
  if (filters.direction === "down") conditions.push(Prisma.sql`d."observedPrice" < d."expectedPrice"`);
  if (filters.q) {
    // Typed text, so its own `%` and `_` are characters, not wildcards.
    const pattern = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // The bare id is what a merchant copies out of the admin's URL.
    const gid = filters.q.startsWith("gid://") ? filters.q : `gid://shopify/ProductVariant/${filters.q}`;
    conditions.push(Prisma.sql`(v."title" ILIKE ${pattern} OR v."sku" ILIKE ${pattern} OR d."variantGid" = ${gid})`);
  }
  // In UTC, like every Prisma write to these columns (see `settleMirror`).
  if (asOf) conditions.push(Prisma.sql`d."detectedAt" <= (${new Date(asOf)}::timestamptz AT TIME ZONE 'UTC')`);

  return Prisma.sql`
    FROM "drift_events" d
    LEFT JOIN "variant_index" v ON v."shopId" = d."shopId" AND v."variantGid" = d."variantGid"
    WHERE ${Prisma.join(conditions, " AND ")}`;
}

/** How many match, by the campaign each belongs to. */
async function matchingByCampaign(shopId: string, filters: DriftFilters, asOf?: string) {
  const rows = await prisma.$queryRaw<Array<{ campaignId: string | null; count: bigint }>>`
    SELECT d."campaignId", COUNT(*)::bigint AS count ${selection(shopId, filters, asOf)}
    GROUP BY d."campaignId"`;
  return rows.map((row) => ({ campaignId: row.campaignId, count: Number(row.count) }));
}

/** One page of matching events, newest first, with `id` breaking ties so pages never overlap. */
export async function driftPage(
  shopId: string,
  filters: DriftFilters,
  page = 1,
  pageSize = ROWS_PER_VIEW,
): Promise<{ rows: DriftRow[]; total: number }> {
  const [ids, counts] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d."id" ${selection(shopId, filters)}
      ORDER BY d."detectedAt" DESC, d."id" DESC
      LIMIT ${pageSize} OFFSET ${(Math.max(1, page) - 1) * pageSize}`,
    matchingByCampaign(shopId, filters),
  ]);
  const events = await prisma.driftEvent.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    include: { campaign: { select: { name: true } } },
  });
  const order = new Map(ids.map((row, index) => [row.id, index]));
  events.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    rows: await driftRowsFor(shopId, events),
    total: counts.reduce((sum, group) => sum + group.count, 0),
  };
}

export interface DriftQueue {
  rows: DriftRow[];
  /** Every drifted price waiting, whatever the filters say. */
  total: number;
  /** Those the filters match. */
  filtered: number;
  /** Every campaign with something waiting, for the filter, with how many. */
  campaigns: Array<{ id: string; name: string; pending: number }>;
  /**
   * The campaign every matching price belongs to, when there is exactly one: what a bulk
   * decision is for. A hold is per campaign and so is a put-back's run, so a decision
   * spanning several would be several decisions behind one button.
   */
  bulk: { id: string; name: string; status: string } | null;
  /** How many campaigns the matching prices belong to. */
  matchingCampaigns: number;
}

export async function driftQueue(shopId: string, filters: DriftFilters, page = 1): Promise<DriftQueue> {
  const [{ rows, total: filtered }, total, waiting, matching] = await Promise.all([
    driftPage(shopId, filters, page),
    prisma.driftEvent.count({ where: { shopId, resolution: "PENDING" } }),
    prisma.driftEvent.groupBy({
      by: ["campaignId"],
      where: { shopId, resolution: "PENDING", campaignId: { not: null } },
      _count: { _all: true },
    }),
    matchingByCampaign(shopId, filters),
  ]);

  const named = await prisma.campaign.findMany({
    where: { shopId, id: { in: [...new Set([...waiting.map((g) => g.campaignId!), ...matching.flatMap((g) => (g.campaignId ? [g.campaignId] : []))])] } },
    select: { id: true, name: true, status: true },
  });
  const byId = new Map(named.map((campaign) => [campaign.id, campaign]));
  const only = matching.length === 1 && matching[0].campaignId ? byId.get(matching[0].campaignId) : undefined;

  return {
    rows,
    total,
    filtered,
    campaigns: waiting
      .flatMap((group) => {
        const campaign = byId.get(group.campaignId!);
        return campaign ? [{ id: campaign.id, name: campaign.name, pending: group._count._all }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    bulk: only ?? null,
    matchingCampaigns: matching.length,
  };
}

interface Selected {
  id: string;
  variantGid: string;
  priceListGid: string;
  observedPrice: bigint | null;
  currency: string;
}

/** Every event one decision covers, in a fixed order. */
async function selectBatch(shopId: string, batch: DriftBatch): Promise<Selected[]> {
  return prisma.$queryRaw<Selected[]>`
    SELECT d."id", d."variantGid", d."priceListGid", d."observedPrice", d."currency"
    ${selection(shopId, { campaignId: batch.campaignId, q: batch.q, direction: batch.direction }, batch.asOf)}
    ORDER BY d."id"`;
}

// ---------------------------------------------------------------------- identity

/**
 * The decision's identity: the same campaign, choice, filters and page load give the same
 * key. It names the run a put-back makes and the one audit entry the decision writes, so a
 * second copy of the same decision -- a double press, a resent job -- finds the first.
 */
export function batchKey(shopId: string, batch: DriftBatch): string {
  return createHash("sha256")
    .update([shopId, batch.campaignId, batch.resolution, batch.q ?? "", batch.direction ?? "", new Date(batch.asOf).getTime()].join("|"))
    .digest("hex")
    .slice(0, 24);
}

/** The one audit entry a decision writes. Derived, so a second writer's insert is a no-op. */
const entryId = (key: string) => `drift-batch-${key}`;

/** The run a put-back makes. `VARIANT-` so it is a scoped run, as the single put-back's is. */
const runKey = (key: string) => `VARIANT-REASSERT-BATCH-${key}`;

// ---------------------------------------------------------------------- deciding

export interface DecideOutcome {
  ok: boolean;
  message: string;
  /** Set when the worker has it: what the page puts in its URL to follow it. */
  batch?: string;
}

/**
 * One decision over the filtered set, from the page: done here when it is small, handed to
 * the worker when it is not.
 */
export async function decideDrift(
  shopId: string,
  batch: DriftBatch,
  actor: string,
  client: AdminClient,
  inlineBudgetMs = PAGE_INLINE_BUDGET_MS,
): Promise<DecideOutcome> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: batch.campaignId, shopId },
    select: { id: true, name: true, status: true, tagKit: true },
  });
  if (!campaign) {
    return {
      ok: false,
      message: "The campaign these prices belong to isn't in this store any more, so nothing was resolved. Reload the page to see what is still waiting.",
    };
  }

  const recorded = await recordedSummary(batchKey(shopId, batch));
  if (recorded) return { ok: true, message: describeBatch(recorded) };

  const events = await selectBatch(shopId, batch);
  if (events.length === 0) {
    return {
      ok: true,
      message: `None of these prices for "${campaign.name}" are waiting any more: they were resolved after the page loaded. Nothing was changed.`,
    };
  }

  const tooLong =
    batch.resolution === "reassert"
      ? await putBackTooLong(shopId, events, campaign.tagKit.length > 0, inlineBudgetMs)
      : events.length > DRIFT_INLINE_ROWS
        ? `${prices(events.length)} is more than this page resolves while you wait.`
        : null;

  if (tooLong) {
    const queue = webQueue();
    if (queue) {
      try {
        await enqueueWithin(queue, "execution", {
          shopId,
          campaignId: campaign.id,
          actor,
          drift: { resolution: batch.resolution, asOf: batch.asOf, ...(batch.q ? { q: batch.q } : {}), ...(batch.direction ? { direction: batch.direction } : {}) },
        });
      } catch (error) {
        logger.warn("a drift decision could not be handed to the worker", {
          shopId,
          campaignId: campaign.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          message:
            `${tooLong} The background worker could not be reached, so nothing was changed. ` +
            "Try again in a minute. If it keeps happening, contact support from the Help page.",
        };
      }
      const ref: BatchRef = { resolution: batch.resolution, campaignId: campaign.id, asOf: batch.asOf, total: events.length };
      return {
        ok: true,
        message: `${doing(batch.resolution, events.length)} for "${campaign.name}" in the background. This page follows it.`,
        batch: formatBatchParam(ref),
      };
    }
    // No worker. Keeping and leaving are database work and finish here; a put-back past the
    // budget would be cut off while still writing prices, which is worse than not starting.
    if (batch.resolution === "reassert") {
      return {
        ok: false,
        message:
          `${tooLong} Started from here it would be cut off part-way through while still writing prices, and the ` +
          "background worker isn't available to take it, so nothing was written. Narrow the filters to fewer products " +
          "and put those back, or try again later.",
      };
    }
  }

  const summary = await executeDriftBatch(shopId, batch, actor, client);
  if (!summary) return { ok: false, message: "Nothing was resolved. Reload the page to see what is still waiting." };
  return { ok: !summary.stopped && !summary.notConfirmed, message: describeBatch(summary) };
}

/**
 * Why a put-back of these variants cannot be written inside the request, or null when it
 * can. The budget the campaign page's Apply uses, counted over the variants in the set:
 * a scoped run never measures itself, because one variant never needed to.
 */
async function putBackTooLong(
  shopId: string,
  events: readonly Selected[],
  tagged: boolean,
  budgetMs: number,
): Promise<string | null> {
  const variants = [...new Set(events.map((event) => event.variantGid))];
  let products = 0;
  if (variants.length <= DEFAULT_THRESHOLD) {
    const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT "productGid")::bigint AS count FROM "variant_index"
      WHERE "shopId" = ${shopId} AND "variantGid" = ANY(${variants})`;
    products = Number(row?.count ?? 0);
  }
  const work = { variants: variants.length, products, taggedProducts: tagged ? products : 0 };
  const reason = overBudget(work, budgetMs);
  if (!reason) return null;
  // `overBudget` speaks of "this campaign"; here it is a set of drifted prices.
  return estimateMs(work) === null
    ? `Putting back ${prices(variants.length)} goes to Shopify as one bulk operation, which a request cannot wait on.`
    : `Putting back ${prices(variants.length)} on ${formatCount(products)} products takes longer than this page can wait.`;
}

/**
 * Carries out one decision: the page's, for a small set, and the worker's otherwise.
 *
 * Returns what happened, and records it as the decision's one audit entry. Returns null
 * only when there is no campaign to decide for.
 */
export async function executeDriftBatch(
  shopId: string,
  batch: DriftBatch,
  actor: string,
  client: AdminClient | null,
): Promise<BatchSummary | null> {
  const key = batchKey(shopId, batch);
  const recorded = await recordedSummary(key);
  if (recorded) return recorded;

  const campaign = await prisma.campaign.findFirst({
    where: { id: batch.campaignId, shopId },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) return null;

  const events = await selectBatch(shopId, batch);
  let outcome: Done = { resolved: [] };
  try {
    if (events.length > 0) {
      outcome =
        batch.resolution === "adopt"
          ? await keepAll(shopId, events, actor)
          : batch.resolution === "ignore"
            ? await leaveAll(events, actor)
            : await putBackAll(shopId, campaign, events, actor, client, key);
    }
  } catch (error) {
    logger.error("a bulk drift decision stopped part-way", {
      shopId,
      campaignId: campaign.id,
      resolution: batch.resolution,
      error: error instanceof Error ? error.message : String(error),
    });
    outcome = { ...outcome, stopped: `${toAppError(error).userMessage} What was resolved before it stopped stays resolved; the rest are still in the queue.` };
  }

  // Another copy of this decision holds its run and will record it.
  if (outcome.twin) {
    return { resolution: batch.resolution, campaign: campaign.name, resolved: 0, stopped: outcome.stopped, stillWaiting: 0, released: false };
  }

  // A held campaign runs again once nothing it was waiting on is left (#756).
  const released = (await releaseHold(shopId, campaign.id, actor))?.changed ?? false;
  const stillWaiting = await prisma.driftEvent.count({ where: { shopId, campaignId: campaign.id, resolution: "PENDING" } });

  const summary: BatchSummary = {
    resolution: batch.resolution,
    campaign: campaign.name,
    resolved: outcome.resolved.length,
    ...(outcome.notKept ? { notKept: outcome.notKept } : {}),
    ...(outcome.notConfirmed ? { notConfirmed: outcome.notConfirmed } : {}),
    ...(outcome.unchanged ? { unchanged: outcome.unchanged } : {}),
    ...(outcome.stopped ? { stopped: outcome.stopped } : {}),
    stillWaiting,
    released,
  };

  // One entry for the decision, naming every variant it resolved (#822): not one per price,
  // which buried the log under 1,113 lines saying the same thing. Variant ids and counts
  // only -- the prices are in the baselines and the run this wrote. Derived id, so a second
  // copy of the decision adds nothing.
  const filters = describeDriftFilters(batch);
  await prisma.auditLogEntry.createMany({
    data: [
      {
        id: entryId(key),
        shopId,
        actor,
        action: `drift.${batch.resolution}`,
        entity: "Campaign",
        entityId: campaign.id,
        after: {
          campaign: campaign.name,
          prices: summary.resolved,
          variantGids: outcome.resolved,
          ...(filters ? { filters } : {}),
          ...(outcome.runId ? { runId: outcome.runId } : {}),
          ...(summary.notKept ? { notKept: summary.notKept } : {}),
          ...(summary.notConfirmed ? { notConfirmed: summary.notConfirmed } : {}),
          ...(summary.unchanged ? { unchanged: summary.unchanged } : {}),
          ...(summary.stopped ? { stopped: summary.stopped } : {}),
          stillWaiting,
          released,
        },
      },
    ],
    skipDuplicates: true,
  });

  return summary;
}

/** What one kind of decision did. */
interface Done {
  /** Variants whose drift this decision resolved. */
  resolved: string[];
  notKept?: number;
  notConfirmed?: number;
  unchanged?: number;
  stopped?: string;
  runId?: string;
  /** Another copy of this decision is writing it; this one did nothing. */
  twin?: boolean;
}

/**
 * Keep: each edit becomes its variant's baseline, as a single "Keep the change" does.
 *
 * An edit the storefront no longer shows is not kept -- a run wrote over it since, and
 * adopting a price that is gone would have every later campaign compute from it (#755).
 * The rest are claimed and given their new baseline in one transaction a chunk, so an
 * event is never claimed without its baseline or the other way round.
 */
async function keepAll(shopId: string, events: readonly Selected[], actor: string): Promise<Done> {
  const resolved: string[] = [];
  let notKept = 0;

  for (const part of chunk(events, CLAIM_CHUNK)) {
    const live = await prisma.priceSurfaceEntry.findMany({
      where: { shopId, surfaceKind: "BASE", variantGid: { in: part.map((event) => event.variantGid) } },
      select: { variantGid: true, priceListGid: true, livePrice: true },
    });
    const liveBy = new Map(live.map((entry) => [`${entry.variantGid}|${entry.priceListGid}`, entry.livePrice]));
    const keepable = part.filter((event) => {
      const shown = liveBy.get(`${event.variantGid}|${event.priceListGid}`);
      return event.observedPrice === null || shown == null || shown === event.observedPrice;
    });
    notKept += part.length - keepable.length;
    if (keepable.length === 0) continue;

    const claimed = await prisma.$transaction(async (tx) => {
      const rows = await claim(tx, keepable, "ADOPTED", actor);
      const priced = rows.filter((row) => row.observedPrice !== null);
      // The single keep's own function (#1013): compare-at and cost carried over.
      await adoptBaselines(
        tx,
        shopId,
        priced.map((row) => ({ variantGid: row.variantGid, priceListGid: row.priceListGid, currency: row.currency, observedPrice: row.observedPrice! })),
        actor,
      );
      return rows;
    });
    resolved.push(...claimed.map((row) => row.variantGid));
  }

  return { resolved, notKept };
}

/** Leave: the alerts close and nothing else changes, as a single "Leave it for now". */
async function leaveAll(events: readonly Selected[], actor: string): Promise<Done> {
  const resolved: string[] = [];
  for (const part of chunk(events, CLAIM_CHUNK)) {
    resolved.push(...(await claim(prisma, part, "IGNORED", actor)).map((row) => row.variantGid));
  }
  return { resolved };
}

/**
 * Put back: the campaign's price written again over every edit in the set, as one run.
 *
 * The ordinary planner, ledger and read-back, scoped to the set's variants -- the single
 * put-back's run, over many. The run closes each event whose price it wrote and read back
 * (#755). An event whose variant it had nothing to write for already shows the campaign's
 * price, or the campaign no longer prices it, so the question is answered and it is closed
 * here. One whose write Shopify did not confirm stays in the queue.
 */
async function putBackAll(
  shopId: string,
  campaign: { id: string; name: string; status: string },
  events: readonly Selected[],
  actor: string,
  client: AdminClient | null,
  key: string,
): Promise<Done> {
  if (!client) {
    return {
      resolved: [],
      stopped: "The app has no working session for this store, so nothing was written. Open the app from your Shopify admin, then put these back again.",
    };
  }
  if (!REASSERTABLE.has(campaign.status)) {
    return {
      resolved: [],
      stopped:
        `"${campaign.name}" is ${campaign.status.toLowerCase()}, so it has no prices to put back right now. Nothing was written. ` +
        "Keep the changes or leave them for now instead, or try again once it has finished.",
    };
  }

  const { runCampaign } = await import("./campaigns/run.server");
  const outcome = await runCampaign(shopId, campaign.id, client, {
    variantGids: [...new Set(events.map((event) => event.variantGid))],
    verifySampleRate: 1,
    occurrenceKey: runKey(key),
    actor,
  });
  if (outcome.deferredTo) return { resolved: [], twin: true, stopped: outcome.messages[0] };
  if (outcome.refused) return { resolved: [], stopped: outcome.refused };

  const ledger = await prisma.variantChange.findMany({
    where: { runId: outcome.runId, surfaceKind: "BASE", priceListGid: "" },
    select: { variantGid: true, status: true },
  });
  const landed = new Set(ledger.filter((row) => (LANDED as readonly string[]).includes(row.status)).map((row) => row.variantGid));
  const sent = new Set(ledger.filter((row) => row.status !== "SKIPPED").map((row) => row.variantGid));

  const after = (
    await Promise.all(
      chunk(events.map((event) => event.id)).map((ids) =>
        prisma.driftEvent.findMany({ where: { id: { in: ids } }, select: { id: true, variantGid: true, resolution: true } }),
      ),
    )
  ).flat();
  const closedByRun = after.filter((event) => event.resolution === "REASSERTED").map((event) => event.variantGid);
  const open = new Set(after.filter((event) => event.resolution === "PENDING").map((event) => event.id));
  const waiting = events.filter((event) => open.has(event.id));

  // Written and read back, but left open -- a clamped price the run does not count as its
  // own -- or nothing to write. Either way the campaign's price is what the storefront shows.
  const answered = waiting.filter((event) => landed.has(event.variantGid) || !sent.has(event.variantGid));
  const closed: string[] = [];
  for (const part of chunk(answered, CLAIM_CHUNK)) {
    closed.push(...(await claim(prisma, part, "REASSERTED", actor)).map((row) => row.variantGid));
  }
  const unchanged = answered.filter((event) => !sent.has(event.variantGid)).length;

  return {
    resolved: [...closedByRun, ...closed],
    unchanged,
    notConfirmed: waiting.length - answered.length,
    runId: outcome.runId,
  };
}

/**
 * Resolves whichever of these events are still pending, and returns those. One statement:
 * an event another decision got to first is not in the answer, so nothing is decided twice.
 */
async function claim(
  db: Pick<typeof prisma, "$queryRaw">,
  events: readonly Selected[],
  resolution: "ADOPTED" | "IGNORED" | "REASSERTED",
  actor: string,
): Promise<Selected[]> {
  if (events.length === 0) return [];
  return db.$queryRaw<Selected[]>`
    UPDATE "drift_events"
    SET "resolution" = ${resolution}::"DriftResolution",
        "resolvedAt" = (${new Date()}::timestamptz AT TIME ZONE 'UTC'),
        "resolvedBy" = ${actor}
    WHERE "id" = ANY(${events.map((event) => event.id)}) AND "resolution" = 'PENDING'
    RETURNING "id", "variantGid", "priceListGid", "observedPrice", "currency"`;
}

// ---------------------------------------------------------------------- following

/** The decision's outcome, if it has been recorded. */
async function recordedSummary(key: string): Promise<BatchSummary | null> {
  const entry = await prisma.auditLogEntry.findUnique({ where: { id: entryId(key) } });
  if (!entry) return null;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  const count = (field: string) => (typeof after[field] === "number" ? (after[field] as number) : undefined);
  return {
    resolution: entry.action.replace(/^drift\./, "") as DriftChoice,
    campaign: typeof after.campaign === "string" ? after.campaign : "this campaign",
    resolved: count("prices") ?? 0,
    notKept: count("notKept"),
    notConfirmed: count("notConfirmed"),
    unchanged: count("unchanged"),
    stopped: typeof after.stopped === "string" ? after.stopped : undefined,
    stillWaiting: count("stillWaiting") ?? 0,
    released: after.released === true,
  };
}

export interface BatchStatus {
  campaign: string;
  ref: BatchRef;
  /** Set once it has finished. */
  done: BatchSummary | null;
  progress: BatchProgress;
}

/** Where a decision the worker has stands, for the page following it. */
export async function batchStatus(
  shopId: string,
  ref: BatchRef,
  filters: Pick<DriftFilters, "q" | "direction">,
): Promise<BatchStatus | null> {
  const campaign = await prisma.campaign.findFirst({ where: { id: ref.campaignId, shopId }, select: { name: true } });
  if (!campaign) return null;

  const batch: DriftBatch = { campaignId: ref.campaignId, resolution: ref.resolution, q: filters.q, direction: filters.direction, asOf: ref.asOf };
  const key = batchKey(shopId, batch);
  const done = await recordedSummary(key);
  if (done) return { campaign: campaign.name, ref, done, progress: { done: done.resolved, written: null, started: true } };

  const [waiting] = await matchingByCampaign(shopId, { ...filters, campaignId: ref.campaignId }, ref.asOf);
  const remaining = waiting?.count ?? 0;

  let written: number | null = null;
  let started = false;
  if (ref.resolution === "reassert") {
    const run = await prisma.campaignRun.findFirst({ where: { campaignId: ref.campaignId, occurrenceKey: runKey(key) }, select: { id: true } });
    if (run) {
      started = true;
      written = await prisma.variantChange.count({
        where: { runId: run.id, surfaceKind: "BASE", priceListGid: "", status: { in: [...LANDED] } },
      });
    }
  }

  return { campaign: campaign.name, ref, done: null, progress: { done: ref.total - remaining, written, started } };
}
