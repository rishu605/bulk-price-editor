/**
 * Deciding which campaign claims a newly-seen variant.
 *
 * A variant can match several campaigns' filters, but only one campaign ever prices
 * it -- the resolver picks a single winner. Enrollment must reach the *same* answer,
 * or we capture a baseline and queue a re-apply for a campaign that will then decline
 * to price the variant, leaving a permanently pending campaign that never settles.
 *
 * So this does not re-implement the ordering. It calls `compareCampaigns`, the same
 * comparator the resolver uses, which makes agreement structural rather than a
 * convention two modules have to remember to keep.
 */

import { compareCampaigns } from "../pricing/resolver";
import type { ResolvableCampaign } from "../pricing/types";

export interface CampaignMatch {
  campaign: ResolvableCampaign;
  /** Variants of the incoming batch that fall inside this campaign's filter. */
  matched: readonly string[];
  /** Variants this campaign has already priced, from its ledger. */
  alreadyPriced: ReadonlySet<string>;
}

export interface EnrollAssignment {
  campaignId: string;
  /** Variants this campaign now owns and has not yet priced. */
  enroll: string[];
}

/**
 * Assigns each variant to its winning campaign, and reports the ones that campaign
 * has not priced yet.
 *
 * Variants already priced by their winner are deliberately absent from the result:
 * a product update webhook fires for stock changes, title edits and everything else,
 * so treating "matches an active campaign" as "needs enrolling" would re-run every
 * campaign on every edit.
 */
export function assignEnrollments(
  matches: readonly CampaignMatch[],
): EnrollAssignment[] {
  const winners = new Map<string, CampaignMatch>();

  for (const match of matches) {
    for (const variantGid of match.matched) {
      const current = winners.get(variantGid);
      if (!current || compareCampaigns(match.campaign, current.campaign) > 0) {
        winners.set(variantGid, match);
      }
    }
  }

  const byCampaign = new Map<string, string[]>();

  for (const [variantGid, match] of winners) {
    // The winner already prices it, so there is nothing to enroll. A losing campaign
    // matching it too is irrelevant -- it would never win at resolve time either.
    if (match.alreadyPriced.has(variantGid)) continue;

    const list = byCampaign.get(match.campaign.id);
    if (list) list.push(variantGid);
    else byCampaign.set(match.campaign.id, [variantGid]);
  }

  // Stable output so callers, logs and tests see a predictable order.
  return [...byCampaign.entries()].map(([campaignId, enroll]) => ({
    campaignId,
    enroll: enroll.sort(),
  }));
}
