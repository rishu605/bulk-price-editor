/**
 * What the plan covers, said before it refuses.
 *
 * RUBIX puts `Free Plan Quota: 150 variants/month · Tasks this month (August): 0/150` on
 * its landing page; NA puts `Current plan: Free · August usage 1/100 (1%)` in settings.
 * We meter too, and the gate is enforced in the run path — so until now the only place a
 * merchant could discover the limit was a campaign refusing to start, which is both the
 * worst moment and the one where it reads as a fault rather than a plan.
 *
 * ## What the number actually means
 *
 * The gate is per campaign, not per month: `canStart` refuses when *one* campaign's scope
 * exceeds `plan.variantLimit`. So a meter counting a monthly total would be a number that
 * has nothing to do with what will be refused — reassuring right up until it is wrong.
 * What this reports is the two figures the gate compares: the cap, and how big the shop's
 * catalogue is. A merchant whose catalogue fits under the cap can never hit it.
 *
 * ## Why the catalogue and not the largest existing campaign
 *
 * The largest campaign's scope is the honest answer to "will my next run be refused", and
 * it costs a scope resolution per campaign to compute — on the perf store that is a
 * hundred thousand rows per campaign, on a page that has to render in under a second.
 * The catalogue size is one indexed count, it is an upper bound on every campaign, and
 * being under it is a guarantee rather than an estimate.
 */

import prisma from "../db.server";
import { billingFor } from "./billing.server";

export interface PlanUsage {
  planName: string;
  /** Null on the tier with no cap, which is a different sentence rather than a big number. */
  variantLimit: number | null;
  /** Variants in the shop's catalogue — the upper bound on any campaign's scope. */
  catalogueVariants: number;
  /** Whether the catalogue alone could exceed what one campaign may cover. */
  couldExceed: boolean;
}

export async function planUsage(shopId: string): Promise<PlanUsage> {
  const [{ plan }, catalogueVariants] = await Promise.all([
    billingFor(shopId),
    prisma.variantIndex.count({ where: { shopId } }),
  ]);

  return {
    planName: plan.name,
    variantLimit: plan.variantLimit,
    catalogueVariants,
    couldExceed: plan.variantLimit !== null && catalogueVariants > plan.variantLimit,
  };
}
