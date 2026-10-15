/**
 * Which drifted variants a campaign no longer prices, and why (#1042).
 *
 * Asked before a put-back plans anything, because the plan cannot tell the two apart: a
 * variant outside the campaign's scope plans nothing, and so does one already at the
 * campaign's price. Only the second is a drift answered. See `lib/drift/not-priced.ts`.
 */

import type { Campaign } from "@prisma/client";

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { whyNotPriced, type NotPriced } from "../../lib/drift/not-priced";
import { astToWhere } from "../segments.server";
import { scopeOf } from "./model.server";

export async function notPricedBy(
  shopId: string,
  campaign: Pick<Campaign, "schedule" | "excludedVariantGids">,
  variantGids: readonly string[],
): Promise<Map<string, NotPriced>> {
  const gids = [...new Set(variantGids)];
  if (gids.length === 0) return new Map();

  // The scope the run plans from, so this and the run cannot disagree about a variant.
  const ast = await scopeOf(shopId, campaign);
  const [rows, inScope, baselines] = await Promise.all([
    inChunks(gids, (batch) =>
      prisma.variantIndex.findMany({
        where: { shopId, variantGid: { in: batch } },
        select: { variantGid: true, deletedAt: true, status: true, isGiftCard: true },
      }),
    ),
    inChunks(gids, (batch) =>
      prisma.variantIndex.findMany({
        where: { ...astToWhere(shopId, ast), variantGid: { in: batch } },
        select: { variantGid: true },
      }),
    ),
    inChunks(gids, (batch) =>
      prisma.baseline.findMany({
        where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: batch } },
        select: { variantGid: true },
      }),
    ),
  ]);

  const rowBy = new Map(rows.map((row) => [row.variantGid, row]));
  const scoped = new Set(inScope.map((row) => row.variantGid));
  const based = new Set(baselines.map((row) => row.variantGid));
  const excluded = new Set(campaign.excludedVariantGids);

  const notPriced = new Map<string, NotPriced>();
  for (const gid of gids) {
    const why = whyNotPriced(
      { row: rowBy.get(gid) ?? null, excluded: excluded.has(gid), inScope: scoped.has(gid), hasBaseline: based.has(gid) },
      ast.productStatuses,
    );
    if (why) notPriced.set(gid, why);
  }
  return notPriced;
}
