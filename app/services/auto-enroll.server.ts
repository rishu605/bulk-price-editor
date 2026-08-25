/**
 * Auto-enrolling products that appear while a campaign is running.
 *
 * A merchant adds a product to a collection that is on sale and expects it to be on
 * sale. Without this it sits at full price until someone notices and re-runs the
 * campaign by hand.
 *
 * Two orderings here are not negotiable:
 *
 *   Mirror first, then baseline. The webhook updates `priceSurfaceEntry` before
 *   calling this, because a baseline is captured from the mirrored live price -- a
 *   variant we have never seen has nothing to capture from.
 *
 *   Baseline, then price. Pricing before recording what the variant normally costs
 *   would make the campaign price its own reference, so the next run would discount
 *   the discount. That is the compounding failure this whole product exists to
 *   prevent (edge case E6).
 *
 * Nothing here writes a price. The webhook must return quickly or Shopify retries it,
 * and a price write is far too slow; enrollment only marks the campaign, and the
 * scheduler applies on its next tick.
 */

import prisma from "../db.server";
import { captureBaselines } from "./baselines.server";
import { astToWhere } from "./segments.server";
import { scopeOf, toResolvable } from "./campaigns/model.server";
import { assignEnrollments, type CampaignMatch } from "../lib/enrollment/assign";

export interface EnrollResult {
  campaignId: string;
  campaignName: string;
  variantGids: string[];
  baselinesCaptured: number;
}

/**
 * Enrols any of `variantGids` that have entered a running campaign's scope.
 *
 * Returns one entry per campaign that gained variants; an empty array is the common
 * case and costs a single indexed query.
 */
export async function enrollNewVariants(
  shopId: string,
  variantGids: string[],
): Promise<EnrollResult[]> {
  if (variantGids.length === 0) return [];

  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["ACTIVE", "PARTIAL"] }, autoEnroll: true },
  });
  if (campaigns.length === 0) return [];

  const matches: CampaignMatch[] = [];

  for (const campaign of campaigns) {
    // Let the database apply the filter rather than re-implementing the AST here.
    const matched = await prisma.variantIndex.findMany({
      where: {
        AND: [
          // Resolved, so a campaign targeting a segment enrolls against the segment's
          // current definition rather than a copy taken when it was created.
          astToWhere(shopId, await scopeOf(shopId, campaign)),
          { variantGid: { in: variantGids } },
        ],
      },
      select: { variantGid: true },
    });
    if (matched.length === 0) continue;

    // What this campaign has already priced. Product-update webhooks fire for stock,
    // title and tag edits constantly, so without this every edit to an on-sale
    // product would queue a fresh run.
    const priced = await prisma.variantChange.findMany({
      where: {
        shopId,
        variantGid: { in: matched.map((row) => row.variantGid) },
        run: { campaignId: campaign.id, kind: "APPLY" },
        status: { in: ["APPLIED", "VERIFIED", "CLAMPED"] },
      },
      select: { variantGid: true },
      distinct: ["variantGid"],
    });

    matches.push({
      campaign: toResolvable(campaign),
      matched: matched.map((row) => row.variantGid),
      alreadyPriced: new Set(priced.map((row) => row.variantGid)),
    });
  }

  const assignments = assignEnrollments(matches);
  if (assignments.length === 0) return [];

  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));
  const results: EnrollResult[] = [];

  for (const assignment of assignments) {
    // Baselines first -- see the note at the top of this file.
    const capture = await captureBaselines(shopId, {
      variantGids: assignment.enroll,
      source: "AUTO_ENROLL",
    });

    await prisma.campaign.update({
      where: { id: assignment.campaignId },
      data: { enrollPendingAt: new Date() },
    });

    await prisma.auditLogEntry.create({
      data: {
        shopId,
        action: "campaign.auto_enroll",
        entity: "Campaign",
        entityId: assignment.campaignId,
        after: {
          variantGids: assignment.enroll,
          baselinesCaptured: capture.captured,
        } as never,
      },
    });

    results.push({
      campaignId: assignment.campaignId,
      campaignName: nameById.get(assignment.campaignId) ?? assignment.campaignId,
      variantGids: assignment.enroll,
      baselinesCaptured: capture.captured,
    });
  }

  return results;
}

/**
 * Campaigns with variants waiting to be priced, oldest first.
 *
 * Oldest first so a backlog drains in the order it arrived rather than starving the
 * campaign that has been waiting longest.
 */
export async function pendingEnrollments(): Promise<
  Array<{ id: string; shopId: string; shopDomain: string }>
> {
  const campaigns = await prisma.campaign.findMany({
    where: { enrollPendingAt: { not: null }, status: { in: ["ACTIVE", "PARTIAL"] } },
    orderBy: { enrollPendingAt: "asc" },
    include: { shop: { select: { id: true, domain: true, uninstalledAt: true } } },
  });

  return campaigns
    .filter((campaign) => !campaign.shop.uninstalledAt)
    .map((campaign) => ({
      id: campaign.id,
      shopId: campaign.shop.id,
      shopDomain: campaign.shop.domain,
    }));
}

/**
 * Clears the pending mark before the re-apply runs, not after.
 *
 * Clearing afterwards would discard any enrolment that arrived *during* the run.
 * Clearing first costs at most one redundant re-apply -- which is idempotent, so it
 * writes nothing -- while the alternative silently drops products.
 */
export async function claimEnrollment(campaignId: string): Promise<boolean> {
  const claimed = await prisma.campaign.updateMany({
    where: { id: campaignId, enrollPendingAt: { not: null } },
    data: { enrollPendingAt: null },
  });
  return claimed.count > 0;
}
