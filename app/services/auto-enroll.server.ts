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
 * and a price write is far too slow; enrollment only marks the campaign with the
 * variants it gained, and the scheduler prices those variants on its next tick.
 *
 * And nothing here touches a campaign that is being ended (#805). A revert that died
 * part-way left its campaign Active, the webhooks of the revert's own writes enrolled a
 * handful of variants, and the re-apply they queued -- a whole-campaign run -- put the
 * sale back on 19,000 variants the merchant had just asked to restore.
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
    const history = await wholeRunHistory(campaign.id);
    // Being ended: a revert asked for since its last apply, in flight or stopped part-way.
    // It is not a campaign anything should join, and a lower-priority one that also covers
    // the variant is what the revert itself resolves to -- so it does not compete here.
    if (history.ending) continue;

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

    // What this campaign has already planned. Product-update webhooks fire for stock,
    // title and tag edits constantly, so without this every edit to an on-sale
    // product would queue a fresh run.
    //
    // Any ledger row since the campaign last ended, whatever its state: a variant it wrote,
    // skipped, failed or left pending is one it already knows about -- a Resume finishes
    // those, not an enrolment. Counting only the rows that landed made every one of them
    // look new on each edit (#805). Since the last revert, so a variant that left the scope
    // in one occurrence and is back in the next is new again.
    const priced = await prisma.variantChange.findMany({
      where: {
        shopId,
        variantGid: { in: matched.map((row) => row.variantGid) },
        run: {
          campaignId: campaign.id,
          ...(history.lastRevertAt ? { createdAt: { gt: history.lastRevertAt } } : {}),
        },
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

    // Appended in the database, so two webhooks enrolling at once both keep their variants.
    await prisma.campaign.update({
      where: { id: assignment.campaignId },
      data: { enrollPendingAt: new Date(), enrollPendingVariantGids: { push: assignment.enroll } },
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
 * Clears the pending mark before the re-apply runs, not after, and returns the variants it
 * held -- or null when another worker claimed it first.
 *
 * Clearing afterwards would discard any enrolment that arrived *during* the run.
 * Clearing first costs at most one redundant re-apply -- which is idempotent, so it
 * writes nothing -- while the alternative silently drops products.
 *
 * Read and cleared under the row's lock, so a webhook enrolling at the same moment cannot
 * lose its variants: its append lands either before this (and is returned) or after (and
 * stays marked for the next tick).
 */
export async function claimEnrollment(campaignId: string): Promise<string[] | null> {
  return prisma.$transaction(async (tx) => {
    const held = await tx.$queryRaw<Array<{ variantGids: string[] | null }>>`
      SELECT "enrollPendingVariantGids" AS "variantGids" FROM "campaigns"
       WHERE "id" = ${campaignId} AND "enrollPendingAt" IS NOT NULL
         FOR UPDATE`;
    if (held.length === 0) return null;
    await tx.campaign.update({
      where: { id: campaignId },
      data: { enrollPendingAt: null, enrollPendingVariantGids: [] },
    });
    return [...new Set(held[0].variantGids ?? [])].sort();
  });
}

/**
 * Whether this campaign is being ended: its latest whole-campaign run is a revert -- asked
 * for, writing, or stopped part-way -- so nothing should join it or be priced into it.
 */
export async function endingSinceLastApply(campaignId: string): Promise<boolean> {
  return (await wholeRunHistory(campaignId)).ending;
}

/**
 * The campaign's whole-campaign runs, as enrolment needs them. Runs over named variants --
 * a single-variant revert, an enrolment -- say nothing about the campaign as a whole.
 */
async function wholeRunHistory(campaignId: string): Promise<{ ending: boolean; lastRevertAt: Date | null }> {
  const whole = { campaignId, NOT: { occurrenceKey: { startsWith: "VARIANT-" } } };
  const [latest, lastRevert] = await Promise.all([
    prisma.campaignRun.findFirst({ where: whole, orderBy: { createdAt: "desc" }, select: { kind: true } }),
    prisma.campaignRun.findFirst({
      where: { ...whole, kind: "REVERT" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return { ending: latest?.kind === "REVERT", lastRevertAt: lastRevert?.createdAt ?? null };
}
