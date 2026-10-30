import type { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { inChunksCounting } from "../../lib/db/chunk";
import { astToWhere } from "../segments.server";
import { DEFINITION, scopeOf } from "./model.server";

/**
 * How many variants a campaign's scope covers: one indexed count, never a plan (#803).
 *
 * For a question a count can answer -- "could this write more than N prices?" -- without
 * loading every candidate and baseline in scope, which on a 102,132-variant campaign held
 * database connections the run itself needed.
 */
export async function scopeSize(shopId: string, campaignId: string): Promise<number> {
  const campaign = await prisma.campaign.findFirstOrThrow({ where: { id: campaignId, shopId }, select: DEFINITION });
  return prisma.variantIndex.count({ where: astToWhere(shopId, await scopeOf(shopId, campaign)) });
}

/**
 * How many of `variantGids` a compiled scope covers: what a run on that list prices (#1075).
 *
 * `loadCandidates` intersects a list with the scope rather than trusting it, so a variant
 * deleted since it was listed, or a gift card, is never priced. Counting the list as sent
 * metered those against the plan. In batches, as `loadCandidates` reads them, and each
 * variant once.
 */
export async function scopedSubsetSize(
  scope: Prisma.VariantIndexWhereInput,
  variantGids: readonly string[],
): Promise<number> {
  const { count } = await inChunksCounting([...new Set(variantGids)], async (batch) => ({
    count: await prisma.variantIndex.count({ where: { AND: [scope, { variantGid: { in: batch } }] } }),
  }));
  return count;
}
