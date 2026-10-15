/**
 * The prices a campaign holds because another campaign's revert handed them over (#998).
 *
 * B (priority 200) ends over A (priority 100), and B's revert writes A's price on the
 * variants they share -- `resolve(without B)`, rule 6. That write is ledgered under B's
 * revert: B's run held the claim (rule 2), and the row was committed before the write
 * (I4). Nothing in the ledger says A now prices those variants, so:
 *
 *  - drift detection, which credits an edit to the campaign that wrote the price, found no
 *    campaign for a hand edit on one, raised no event and held nothing -- and A's revert
 *    later rewrote the edit without asking;
 *  - A's whole revert, which takes back what A wrote wherever the scope has gone since
 *    (#828), never took back an inherited price once the product left A's scope.
 *
 * The ledger stays as it is. Which campaign a handover went to is asked of the planner,
 * from what the revert wrote (`lib/planning/handover.ts`), whenever it is needed.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { inheritors } from "../../lib/planning/handover";
import { guardrailsFor } from "../settings.server";
import { loadCandidates, pricesWrittenBy } from "./candidates.server";
import { competingCampaigns, heldEditsOf, importIdsOf, withScopes } from "./model.server";

type Pricing = Awaited<ReturnType<typeof competingCampaigns>>[number];

/**
 * The campaign pricing this variant by a handover: the one whose price the revert that
 * last wrote it put there (#998). For drift detection, when the newest write to a variant
 * was a revert. Null when that price is no running campaign's -- its baseline, usually.
 */
export async function inheritorOf(
  shopId: string,
  variantGid: string,
  /** What the revert wrote, in minor units. */
  handedOver: bigint,
): Promise<Pick<Pricing, "id" | "name" | "status"> | null> {
  return (await inheritorsOf(shopId, new Map([[variantGid, handedOver]]))).get(variantGid) ?? null;
}

/**
 * The same for many variants at once, by variant (#1043): What's live asks it of a page of
 * prices whose newest write was another campaign's revert. Absent: nobody's.
 */
export async function inheritorsOf(
  shopId: string,
  /** Variant gid -> what the revert wrote there, in minor units. */
  handedOver: ReadonlyMap<string, bigint>,
): Promise<Map<string, Pick<Pricing, "id" | "name" | "status">>> {
  if (handedOver.size === 0) return new Map();
  // Running, and not being ended: a campaign handing its variants back keeps none (#805).
  const pricing = await competingCampaigns(shopId);
  if (pricing.length === 0) return new Map();
  const byId = new Map(pricing.map((campaign) => [campaign.id, campaign]));
  const found = await inheritorsAmong(shopId, pricing, handedOver);
  return new Map([...found].flatMap(([gid, id]) => (byId.has(id) ? [[gid, byId.get(id)!] as const] : [])));
}

/**
 * The variants this campaign prices because another campaign's revert handed them to it,
 * with the price that revert wrote, for those still showing nothing newer of ours (#998).
 * Whatever the campaign's scope says now: a product archived since is still at its price.
 */
export async function inheritedBy(
  shopId: string,
  campaignId: string,
  /** Only these variants, for a caller asking about a few (auto-enrol, #1043). */
  among?: readonly string[],
): Promise<Map<string, bigint>> {
  if (among?.length === 0) return new Map();
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId } });
  if (!campaign) return new Map();

  const since = await sinceLastEnded(campaign);

  // Each variant whose newest landed base write is another campaign's revert: a price that
  // revert recomputed, and nothing has written over since. Deleted variants are left out,
  // as `pricesWrittenBy` leaves them: there is nothing on the storefront to take back.
  const rows = await prisma.$queryRaw<Array<{ variantGid: string; intendedPrice: bigint }>>`
    SELECT c."variantGid", c."intendedPrice"
    FROM "variant_changes" c
    JOIN "campaign_runs" r ON r."id" = c."runId"
    JOIN "variant_index" v ON v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"
    WHERE r."shopId" = ${shopId} AND r."kind" = 'REVERT' AND r."campaignId" <> ${campaignId}
      AND r."createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
      AND c."shopId" = ${shopId} AND c."surfaceKind" = 'BASE' AND c."priceListGid" = ''
      AND c."status" IN ('VERIFIED', 'CLAMPED') AND c."intendedPrice" IS NOT NULL
      AND v."deletedAt" IS NULL
      ${among ? Prisma.sql`AND c."variantGid" = ANY(${[...among]})` : Prisma.empty}
      AND NOT EXISTS (
        SELECT 1 FROM "variant_changes" n
        WHERE n."shopId" = c."shopId" AND n."variantGid" = c."variantGid"
          AND n."surfaceKind" = 'BASE' AND n."priceListGid" = ''
          AND n."status" IN ('VERIFIED', 'CLAMPED')
          AND (n."createdAt" > c."createdAt" OR (n."createdAt" = c."createdAt" AND n."id" > c."id"))
      )`;
  if (rows.length === 0) return new Map();

  // This campaign whatever its state -- its own revert asks this while it is REVERTING --
  // beside every other campaign still pricing, any of which may be the one handed it.
  const handedOver = new Map(rows.map((row) => [row.variantGid, row.intendedPrice]));
  const winners = await inheritorsAmong(shopId, [campaign, ...(await competingCampaigns(shopId, campaignId))], handedOver);
  return new Map([...handedOver].filter(([gid]) => winners.get(gid) === campaignId));
}

/**
 * The market prices another campaign's revert handed this one (#1043), on these lists.
 *
 * The same handover as `inheritedBy`, on a market: B ends and its revert writes A's price
 * on the lists they share (#1038), ledgered under B's revert -- so A's own revert, taking
 * back the market rows of A's runs, left A's price there after A ended. Each cell whose
 * newest landed write is another campaign's revert since this one last ended, and whose
 * mirror still shows what that revert wrote: a price changed by hand since is nobody's to
 * take back.
 *
 * Not narrowed to the cells the planner would credit to this campaign. The revert that
 * takes them back recomputes each one without it (rule 6) -- written back where another
 * campaign or a hand-set price accounts for it, released to the list otherwise -- so a cell
 * that was not this campaign's is written its own price.
 */
export async function marketsHandedTo(
  shopId: string,
  campaignId: string,
  priceListGids: readonly string[],
): Promise<Array<{ variantGid: string; priceListGid: string }>> {
  if (priceListGids.length === 0) return [];
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { id: true, createdAt: true } });
  if (!campaign) return [];
  const since = await sinceLastEnded(campaign);
  return prisma.$queryRaw<Array<{ variantGid: string; priceListGid: string }>>`
    SELECT c."variantGid", c."priceListGid"
    FROM "variant_changes" c
    JOIN "campaign_runs" r ON r."id" = c."runId"
    JOIN "price_surface_entries" e
      ON e."shopId" = c."shopId" AND e."variantGid" = c."variantGid" AND e."priceListGid" = c."priceListGid"
    WHERE r."shopId" = ${shopId} AND r."kind" = 'REVERT' AND r."campaignId" <> ${campaignId}
      AND r."createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
      AND c."shopId" = ${shopId} AND c."priceListGid" = ANY(${[...priceListGids]})
      AND c."status" IN ('VERIFIED', 'CLAMPED') AND c."intendedPrice" IS NOT NULL
      AND e."livePrice" = c."intendedPrice"
      AND NOT EXISTS (
        SELECT 1 FROM "variant_changes" n
        WHERE n."shopId" = c."shopId" AND n."variantGid" = c."variantGid" AND n."priceListGid" = c."priceListGid"
          AND n."status" IN ('VERIFIED', 'CLAMPED')
          AND (n."createdAt" > c."createdAt" OR (n."createdAt" = c."createdAt" AND n."id" > c."id"))
      )`;
}

/**
 * Since this campaign last finished ending, as for what it wrote (`pricesWrittenBy`):
 * nothing handed to it before then is still its own.
 */
async function sinceLastEnded(campaign: { id: string; createdAt: Date }): Promise<Date> {
  const lastRevert = await prisma.campaignRun.findFirst({
    where: { campaignId: campaign.id, kind: "REVERT", status: "COMPLETED", NOT: { occurrenceKey: { startsWith: "VARIANT-" } } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return lastRevert?.createdAt ?? campaign.createdAt;
}

/**
 * What a whole-campaign revert takes back: every price this campaign wrote since it last
 * ended (#828), and every price another campaign's revert handed it (#998). The revert and
 * both of its previews plan over these, in scope or not.
 */
export async function revertTakesBack(shopId: string, campaignId: string): Promise<string[]> {
  const [written, inherited] = await Promise.all([pricesWrittenBy(shopId, campaignId), inheritedBy(shopId, campaignId)]);
  return [...new Set([...written, ...inherited.keys()])];
}

/** `inheritors`, with what it needs loaded: the campaigns' scopes over these variants only. */
async function inheritorsAmong(
  shopId: string,
  campaigns: readonly Pricing[],
  handedOver: ReadonlyMap<string, bigint>,
): Promise<Map<string, string>> {
  const gids = [...handedOver.keys()];
  const resolvable = await withScopes(shopId, campaigns, gids);
  const [candidates, storeGuardrails, heldEdits] = await Promise.all([
    // With no conditions and no status, as `withWritten` loads strays: an archived
    // product's variant is still asked about.
    loadCandidates(shopId, { groups: [] }, gids, importIdsOf(resolvable)),
    guardrailsFor(shopId),
    heldEditsOf(shopId, campaigns),
  ]);
  return inheritors({
    campaigns: resolvable,
    candidates,
    handedOver: new Map([...handedOver].map(([gid, price]) => [gid, Number(price)])),
    storeGuardrails,
    heldEdits,
  });
}
