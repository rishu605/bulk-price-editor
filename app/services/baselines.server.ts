/**
 * Baseline capture — the product's core differentiator.
 *
 * A baseline is the durable reference price every campaign computes from. Because
 * campaign maths reads it instead of the live price, re-running a campaign is
 * idempotent and reverting is exact. Competitors apply "-20%" to whatever is
 * currently live, which is why their re-runs compound and their reverts drift.
 *
 * Baselines are **append-only**: a recapture supersedes the previous row rather than
 * updating it, so the history of what a variant's reference price used to be
 * survives. A partial unique index enforces exactly one current row per variant per
 * surface.
 */

import type { BaselineSource, Prisma, SurfaceKind } from "@prisma/client";

import prisma from "../db.server";
import { chunk, inChunks } from "../lib/db/chunk";
import { readBaselineLadders } from "../lib/execution/quantity-executor";
import type { AdminClient } from "../lib/execution/sync-executor";
import { logger } from "../lib/logging/logger";
import { serialiseLadder, type LadderRung } from "../lib/pricing/ladder-baseline";

export interface CaptureResult {
  captured: number;
  alreadyCurrent: number;
  superseded: number;
  /** Of `captured`, wholesale prices, each recorded with its quantity ladder (#1092). */
  wholesale: number;
  /**
   * Wholesale prices this capture would have recorded and left as they were: it had no
   * Admin client, or Shopify could not be read for their ladders. See `client`.
   */
  wholesaleLeft: number;
}

export interface CaptureOptions {
  /** Restrict to these variants. Omit to capture the whole catalogue. */
  variantGids?: string[];
  /**
   * Replace existing current baselines. Off by default, because recapturing while a
   * sale is live would enshrine sale prices as the new "normal" -- permanently.
   */
  recapture?: boolean;
  source?: BaselineSource;
  capturedBy?: string;
  /** Called after each chunk is written: surfaces captured so far, of how many (#801). */
  onProgress?: (done: number, total: number) => void | Promise<void>;
  /**
   * Shopify, for a wholesale catalogue's quantity ladders (#1071).
   *
   * A wholesale price is baselined with its ladder or not at all, because a baseline's null
   * ladder says "the merchant had none", and a revert clears a ladder on that word. Without
   * a client a wholesale price is left as it is, and the campaign captures it -- ladder and
   * all -- before it first writes there. The sync and the merchant's recapture pass one; an
   * auto-enrolment, answering a webhook, cannot wait on the read.
   */
  client?: AdminClient;
}

/** A baseline about to be written, and the current one it replaces. */
interface PlannedBaseline {
  row: Prisma.BaselineCreateManyInput & { priceListGid: string; currency: string };
  supersedes: string | null;
}

/**
 * Captures baselines from the mirrored live values.
 *
 * Variants that already have a current baseline are left alone unless `recapture` is
 * set. That default matters: capture runs after every sync, and silently re-anchoring
 * to live prices on each run would destroy the entire guarantee.
 */
export async function captureBaselines(
  shopId: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const result: CaptureResult = { captured: 0, alreadyCurrent: 0, superseded: 0, wholesale: 0, wholesaleLeft: 0 };

  const entries = options.variantGids
    ? await inChunks(options.variantGids, (batch) =>
        prisma.priceSurfaceEntry.findMany({ where: { shopId, variantGid: { in: batch } } }),
      )
    : await prisma.priceSurfaceEntry.findMany({ where: { shopId } });

  const existing = await prisma.baseline.findMany({
    where: { shopId, supersededAt: null },
    select: { id: true, variantGid: true, surfaceKind: true, priceListGid: true },
  });

  // A wholesale baseline filed as B2B: the sync's before #1071, and the release before this
  // one's still. Nothing prices from it -- every campaign reads a price list's baseline as
  // MARKET -- so beside the campaign's own it is a second baseline for the price, at the sale
  // price when a sync ran during the sale. Put away here, as the migration put away the ones
  // before it, and the price is captured below as MARKET if it has no baseline left.
  const inScope = options.variantGids ? new Set(options.variantGids) : null;
  const filedAsB2B = existing.filter((b) => b.surfaceKind === "B2B" && (!inScope || inScope.has(b.variantGid)));
  for (const batch of chunk(filedAsB2B.map((b) => b.id))) {
    await prisma.baseline.updateMany({ where: { id: { in: batch } }, data: { supersededAt: new Date() } });
  }
  if (filedAsB2B.length > 0) {
    logger.info("superseded wholesale baselines filed as B2B", { shopId, superseded: filedAsB2B.length });
  }

  const currentKey = new Map(
    existing
      .filter((b) => b.surfaceKind !== "B2B")
      .map((b) => [cellKey(b.variantGid, b.surfaceKind, b.priceListGid), b.id]),
  );

  // Costs are fetched once for the whole batch. Looking them up per variant meant
  // three round trips each, which on a 1,600-variant catalogue is thousands of
  // queries and minutes of wall time -- capture appeared to stall entirely.
  const costs = new Map(
    (
      await prisma.variantIndex.findMany({
        where: { shopId },
        select: { variantGid: true, cost: true },
      })
    ).map((v) => [v.variantGid, v.cost]),
  );

  const planned: PlannedBaseline[] = [];
  const wholesale: PlannedBaseline[] = [];

  for (const entry of entries) {
    // A surface with no live price has nothing to anchor to. Recording zero would be
    // a lie that every future campaign would compute from.
    if (entry.livePrice === null) continue;

    const surfaceKind = baselineKindOf(entry.surfaceKind);
    const currentId = currentKey.get(cellKey(entry.variantGid, surfaceKind, entry.priceListGid));

    if (currentId && !options.recapture) {
      result.alreadyCurrent++;
      continue;
    }

    const baseline: PlannedBaseline = {
      supersedes: currentId ?? null,
      row: {
        shopId,
        variantGid: entry.variantGid,
        surfaceKind,
        priceListGid: entry.priceListGid,
        currency: entry.currency,
        basePrice: entry.livePrice,
        baseCompareAt: entry.liveCompareAt,
        cost: costs.get(entry.variantGid) ?? null,
        handSet: handSetFromMirror(entry),
        source: options.source ?? (currentId ? "RECAPTURE" : "INSTALL_CAPTURE"),
        capturedBy: options.capturedBy ?? null,
      },
    };
    (entry.surfaceKind === "B2B" ? wholesale : planned).push(baseline);
  }

  // Wholesale prices with their ladders, or not at all: see `client`.
  const laddered = options.client ? await withLadders(shopId, options.client, wholesale) : [];
  planned.push(...laddered);
  result.wholesale = laddered.length;
  result.wholesaleLeft = wholesale.length - laddered.length;

  // Supersede and create together per chunk. The partial unique index allows only
  // one current baseline per variant per surface, so the old row must be retired in
  // the same transaction that adds its replacement -- otherwise a mid-batch failure
  // leaves either two current baselines or none, and campaign maths depends on
  // exactly one. Each chunk retires the rows its own baselines replace.
  const CHUNK = 1_000;
  for (let i = 0; i < planned.length; i += CHUNK) {
    const createChunk = planned.slice(i, i + CHUNK);
    const supersedeChunk = createChunk.flatMap((baseline) => (baseline.supersedes ? [baseline.supersedes] : []));

    await prisma.$transaction([
      ...(supersedeChunk.length > 0
        ? [
            prisma.baseline.updateMany({
              where: { id: { in: supersedeChunk } },
              data: { supersededAt: new Date() },
            }),
          ]
        : []),
      prisma.baseline.createMany({ data: createChunk.map((baseline) => baseline.row) }),
    ]);
    await options.onProgress?.(Math.min(i + CHUNK, planned.length), planned.length);

    result.captured += createChunk.length;
    result.superseded += supersedeChunk.length;
  }

  return result;
}

/**
 * The wholesale prices among these variants that a capture records with their quantity
 * ladders, counted by price list: the mirror's wholesale rows with a live price, as
 * `captureBaselines` reads them. For deciding, before a capture, how many ladder reads it
 * will make (#1092).
 */
export async function wholesalePricesIn(shopId: string, variantGids: readonly string[]): Promise<Map<string, number>> {
  const rows = await inChunks([...variantGids], (batch) =>
    prisma.priceSurfaceEntry.groupBy({
      by: ["priceListGid"],
      where: { shopId, surfaceKind: "B2B", variantGid: { in: batch }, livePrice: { not: null } },
      _count: { _all: true },
    }),
  );
  const byList = new Map<string, number>();
  for (const row of rows) byList.set(row.priceListGid, (byList.get(row.priceListGid) ?? 0) + row._count._all);
  return byList;
}

/**
 * The kind a baseline from this mirror row is filed under: a price list's as MARKET, a
 * wholesale catalogue's included (#1071).
 *
 * The mirror files a wholesale catalogue's prices as B2B, which is how What's live names the
 * list and billing gates it. A baseline does not: every campaign reads and captures a price
 * list's baseline as MARKET -- `marketBaselines`, `captureMarketBaselines`, `handSetAmong` --
 * and the kind is part of the one-current-baseline index. Filed as B2B, the sync's baseline
 * was one no campaign read, so the campaign captured a second; and the sync, looking for a
 * B2B one, did not see the campaign's, so a sync during a sale baselined the sale price.
 */
function baselineKindOf(kind: SurfaceKind): SurfaceKind {
  return kind === "B2B" ? "MARKET" : kind;
}

/** A price's one current baseline, as the partial unique index keys it. */
function cellKey(variantGid: string, surfaceKind: SurfaceKind, priceListGid: string): string {
  return `${variantGid}|${surfaceKind}|${priceListGid}`;
}

/**
 * Whether a baseline taken from this mirror row is a price the merchant set by hand on the
 * list, as the revert reads it (#1064).
 *
 * Any list's row is, a wholesale catalogue's as much as a market's: the markets sync mirrors
 * a list's fixed prices and nothing else -- a price the list derives has no row -- and a
 * price a campaign has written already has the MARKET baseline the campaign captured before
 * writing, so this capture skips it and never takes a campaign's price for the merchant's.
 * Left unsaid, the campaign took this baseline as its own without ever recording the flag,
 * and the revert deleted the merchant's price for the one the list's percentage derives
 * (#930). The base price has no list to be fixed on.
 */
function handSetFromMirror(entry: { priceListGid: string }): boolean | null {
  return entry.priceListGid !== "" ? true : null;
}

/**
 * Wholesale baselines with the quantity ladder each price has now, the merchant's: as a
 * campaign's capture records it, through the same read (#704, #1071).
 *
 * A catalogue Shopify cannot be read for is left out rather than recorded as "no ladder",
 * which is a claim the revert would act on. Its prices are captured by the next sync, or by
 * the campaign before it first writes them -- whichever comes first.
 */
async function withLadders(
  shopId: string,
  client: AdminClient,
  wholesale: readonly PlannedBaseline[],
): Promise<PlannedBaseline[]> {
  const byList = new Map<string, PlannedBaseline[]>();
  for (const baseline of wholesale) {
    const list = byList.get(baseline.row.priceListGid);
    if (list) list.push(baseline);
    else byList.set(baseline.row.priceListGid, [baseline]);
  }

  const out: PlannedBaseline[] = [];
  for (const [priceListGid, baselines] of byList) {
    let ladders: Map<string, LadderRung[]>;
    try {
      ladders = await readBaselineLadders(
        client,
        priceListGid,
        baselines[0]!.row.currency,
        baselines.map((baseline) => baseline.row.variantGid),
      );
    } catch (error) {
      logger.warn("wholesale prices not baselined: their quantity ladders could not be read", {
        shopId,
        priceListGid,
        variants: baselines.length,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const baseline of baselines) {
      // Null for most: a wholesale price usually has no ladder, and null says so. Cast at the
      // boundary, as the campaign's capture does: `serialiseLadder` is the check that matters.
      const ladder = serialiseLadder(ladders.get(baseline.row.variantGid) ?? []);
      if (ladder) baseline.row.quantityBreaks = ladder as unknown as Prisma.InputJsonValue;
      out.push(baseline);
    }
  }
  return out;
}

export interface BaselineHealth {
  variants: number;
  withBaseline: number;
  missing: number;
  /** Variants whose live price no longer matches their baseline. */
  drifted: number;
  oldestCapturedAt: Date | null;
}

/**
 * Coverage and staleness, for the dashboard.
 *
 * "Drifted" here means live differs from baseline, which is expected while a
 * campaign is running and a warning sign when none is. The dashboard says which.
 */
export async function baselineHealth(shopId: string): Promise<BaselineHealth> {
  // One aggregate rather than three full table reads diffed in memory.
  //
  // The previous version pulled every baseline and every price-surface row into the
  // process and compared them in a loop. That is fine on a dev store and quietly
  // quadratic in memory on a real one: a 500K-variant catalogue means a million rows
  // crossing the wire to compute four numbers, on the app's landing page, on every
  // load. The dashboard has a sub-second budget and this was the whole of it.
  const [row] = await prisma.$queryRaw<
    Array<{
      variants: bigint;
      withBaseline: bigint;
      drifted: bigint;
      oldest: Date | null;
    }>
  >`
    SELECT
      (SELECT count(*) FROM "variant_index"
        WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL) AS "variants",
      count(b.*) AS "withBaseline",
      count(*) FILTER (
        WHERE e."livePrice" IS NOT NULL AND e."livePrice" <> b."basePrice"
      ) AS "drifted",
      min(b."capturedAt") AS "oldest"
    FROM "baselines" b
    LEFT JOIN "price_surface_entries" e
      ON e."shopId" = b."shopId"
     AND e."variantGid" = b."variantGid"
     AND e."surfaceKind" = 'BASE'
     AND e."priceListGid" = ''
    WHERE b."shopId" = ${shopId}
      AND b."supersededAt" IS NULL
      AND b."surfaceKind" = 'BASE'
  `;

  const variants = Number(row?.variants ?? 0);
  const withBaseline = Number(row?.withBaseline ?? 0);

  return {
    variants,
    withBaseline,
    // Clamped, because a catalogue can carry baselines for variants since deleted --
    // the tombstones stay so ledger rows resolve on revert (E4). A negative "missing"
    // reads as a bug in the dashboard rather than as the expected consequence.
    missing: Math.max(0, variants - withBaseline),
    drifted: Number(row?.drifted ?? 0),
    oldestCapturedAt: row?.oldest ?? null,
  };
}

/**
 * Carries Shopify's cost onto each current base baseline (#737).
 *
 * The guardrails read `baseline.cost ?? variant.cost`, and a catalogue sync updated only
 * the mirror's. A cost raised in Shopify from $5 to $8 left the baseline at $5, so "never
 * below cost" floored a sale at $5 and allowed $7, while the cost import, comparing with the
 * mirror, called a re-import of $8 "already matched" and wrote nothing.
 *
 * The decision, also in docs/decisions.md: **Shopify's cost wins where Shopify has one.**
 * After a sync, a current baseline whose cost differs from a non-null mirror cost takes the
 * mirror's. Where Shopify has no cost the baseline keeps what it has, which is how a cost
 * imported from a spreadsheet survives the sync that empties the mirror's.
 *
 * A cost is not a price: rule 1 keeps campaign maths on the baseline's *price*, which this
 * leaves alone. Returns the number of baselines changed.
 */
export async function carryShopifyCosts(shopId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "baselines" b
    SET "cost" = v."cost"
    FROM "variant_index" v
    WHERE v."shopId" = ${shopId}
      AND b."shopId" = v."shopId"
      AND b."variantGid" = v."variantGid"
      AND b."surfaceKind" = 'BASE'
      AND b."priceListGid" = ''
      AND b."supersededAt" IS NULL
      AND v."cost" IS NOT NULL
      AND b."cost" IS DISTINCT FROM v."cost"`;
}
