import prisma from "../../db.server";
import { astToWhere } from "../segments.server";
import { scopeOf } from "./model.server";

/**
 * How many variants a campaign's scope covers: one indexed count, never a plan (#803).
 *
 * For a question a count can answer -- "could this write more than N prices?" -- without
 * loading every candidate and baseline in scope, which on a 102,132-variant campaign held
 * database connections the run itself needed.
 */
export async function scopeSize(shopId: string, campaignId: string): Promise<number> {
  const campaign = await prisma.campaign.findFirstOrThrow({ where: { id: campaignId, shopId }, select: { schedule: true } });
  return prisma.variantIndex.count({ where: astToWhere(shopId, await scopeOf(shopId, campaign)) });
}
