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
 *
 * ## Which catalogue
 *
 * The one a campaign can reach, compiled by `astToWhere` as every campaign's scope is:
 * live variants that are not gift cards (#1075). Counting every row the shop had -- deleted
 * variants and gift cards too -- told a shop near its limit that it could exceed it by
 * variants no campaign would ever count, and stopped the guarantee being one: the gate
 * counts through the same filter, so it can only ever count fewer than this.
 */

import prisma from "../db.server";
import { billingFor } from "./billing.server";
import { astToWhere, type FilterAst } from "./segments.server";

export interface PlanUsage {
  planName: string;
  /** Null on the tier with no cap, which is a different sentence rather than a big number. */
  variantLimit: number | null;
  /** Variants a campaign could cover — the upper bound on any campaign's scope. */
  catalogueVariants: number;
  /** Live gift cards, which no campaign prices, left out of `catalogueVariants`. */
  giftCards: number;
  /** Whether the catalogue alone could exceed what one campaign may cover. */
  couldExceed: boolean;
  /** A development store: every feature, nothing charged, whatever plan it is on. */
  exempt: boolean;
}

/** The widest scope a campaign can have: no conditions, and every product status. */
const EVERY_VARIANT: FilterAst = { groups: [] };

export interface CoverableCatalogue {
  /** What the widest campaign would cover. */
  variants: number;
  /** Live gift cards: the one floor of `astToWhere` a merchant would otherwise miss. */
  giftCards: number;
}

/**
 * How much of the catalogue a campaign could cover, for the meter on Home and on
 * Settings → Plan alike, so the two cannot name different numbers.
 *
 * Through `astToWhere`, not a copy of its floors. The gift cards are the same filter with
 * its one gift-card clause turned round, so a deleted gift card is in neither count.
 */
export async function coverableCatalogue(shopId: string): Promise<CoverableCatalogue> {
  const coverable = astToWhere(shopId, EVERY_VARIANT);
  const [variants, giftCards] = await Promise.all([
    prisma.variantIndex.count({ where: coverable }),
    prisma.variantIndex.count({ where: { ...coverable, isGiftCard: true } }),
  ]);
  return { variants, giftCards };
}

export async function planUsage(shopId: string): Promise<PlanUsage> {
  const [{ plan, exempt }, catalogue] = await Promise.all([billingFor(shopId), coverableCatalogue(shopId)]);

  return {
    planName: plan.name,
    variantLimit: plan.variantLimit,
    catalogueVariants: catalogue.variants,
    giftCards: catalogue.giftCards,
    couldExceed: plan.variantLimit !== null && catalogue.variants > plan.variantLimit,
    exempt,
  };
}
