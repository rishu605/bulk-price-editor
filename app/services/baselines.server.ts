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

    const variant = await prisma.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId, variantGid: entry.variantGid } },
      select: { cost: true },
    });

    await prisma.$transaction(async (tx) => {
      if (currentId) {
        await tx.baseline.update({
          where: { id: currentId },
          data: { supersededAt: new Date() },
        });
        result.superseded++;
      }
      await tx.baseline.create({
        data: {
          shopId,
          variantGid: entry.variantGid,
          surfaceKind: entry.surfaceKind,
          priceListGid: entry.priceListGid,
          currency: entry.currency,
          basePrice: entry.livePrice!,
          baseCompareAt: entry.liveCompareAt,
          cost: variant?.cost ?? null,
          source: options.source ?? (currentId ? "RECAPTURE" : "INSTALL_CAPTURE"),
          capturedBy: options.capturedBy ?? null,
        },
      });
    });

    result.captured++;
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
  const [variants, current] = await Promise.all([
    prisma.variantIndex.count({ where: { shopId, deletedAt: null } }),
    prisma.baseline.findMany({
      where: { shopId, supersededAt: null },
      select: { variantGid: true, surfaceKind: true, priceListGid: true, basePrice: true, capturedAt: true },
    }),
  ]);

  const entries = await prisma.priceSurfaceEntry.findMany({
    where: { shopId, surfaceKind: "BASE" },
    select: { variantGid: true, livePrice: true },
  });

  const liveByVariant = new Map(entries.map((e) => [e.variantGid, e.livePrice]));

  let drifted = 0;
  let oldest: Date | null = null;
  const baseSurface = current.filter((b) => b.surfaceKind === "BASE");

  for (const baseline of baseSurface) {
    const live = liveByVariant.get(baseline.variantGid);
    if (live !== undefined && live !== null && live !== baseline.basePrice) drifted++;
    if (!oldest || baseline.capturedAt < oldest) oldest = baseline.capturedAt;
  }

  return {
    variants,
    withBaseline: baseSurface.length,
    missing: Math.max(0, variants - baseSurface.length),
    drifted,
    oldestCapturedAt: oldest,
  };
}
