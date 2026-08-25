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

import prisma from "../db.server";
import type { BaselineSource } from "@prisma/client";

export interface CaptureResult {
  captured: number;
  alreadyCurrent: number;
  superseded: number;
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
  const result: CaptureResult = { captured: 0, alreadyCurrent: 0, superseded: 0 };

  const entries = await prisma.priceSurfaceEntry.findMany({
    where: {
      shopId,
      ...(options.variantGids ? { variantGid: { in: options.variantGids } } : {}),
    },
  });

  const existing = await prisma.baseline.findMany({
    where: { shopId, supersededAt: null },
    select: { id: true, variantGid: true, surfaceKind: true, priceListGid: true },
  });

  const currentKey = new Map(
    existing.map((b) => [`${b.variantGid}|${b.surfaceKind}|${b.priceListGid}`, b.id]),
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

  const toSupersede: string[] = [];
  const toCreate: Array<{
    shopId: string;
    variantGid: string;
    surfaceKind: (typeof entries)[number]["surfaceKind"];
    priceListGid: string;
    currency: string;
    basePrice: bigint;
    baseCompareAt: bigint | null;
    cost: bigint | null;
    source: BaselineSource;
    capturedBy: string | null;
  }> = [];

  for (const entry of entries) {
    // A surface with no live price has nothing to anchor to. Recording zero would be
    // a lie that every future campaign would compute from.
    if (entry.livePrice === null) continue;

    const key = `${entry.variantGid}|${entry.surfaceKind}|${entry.priceListGid}`;
    const currentId = currentKey.get(key);

    if (currentId && !options.recapture) {
      result.alreadyCurrent++;
      continue;
    }

    if (currentId) toSupersede.push(currentId);

    toCreate.push({
      shopId,
      variantGid: entry.variantGid,
      surfaceKind: entry.surfaceKind,
      priceListGid: entry.priceListGid,
      currency: entry.currency,
      basePrice: entry.livePrice,
      baseCompareAt: entry.liveCompareAt,
      cost: costs.get(entry.variantGid) ?? null,
      source: options.source ?? (currentId ? "RECAPTURE" : "INSTALL_CAPTURE"),
      capturedBy: options.capturedBy ?? null,
    });
  }

  // Supersede and create together per chunk. The partial unique index allows only
  // one current baseline per variant per surface, so the old row must be retired in
  // the same transaction that adds its replacement -- otherwise a mid-batch failure
  // leaves either two current baselines or none, and campaign maths depends on
  // exactly one.
  const CHUNK = 1_000;
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const createChunk = toCreate.slice(i, i + CHUNK);
    const supersedeChunk = toSupersede.slice(i, i + CHUNK);

    await prisma.$transaction([
      ...(supersedeChunk.length > 0
        ? [
            prisma.baseline.updateMany({
              where: { id: { in: supersedeChunk } },
              data: { supersededAt: new Date() },
            }),
          ]
        : []),
      prisma.baseline.createMany({ data: createChunk }),
    ]);

    result.captured += createChunk.length;
    result.superseded += supersedeChunk.length;
  }

  return result;
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
