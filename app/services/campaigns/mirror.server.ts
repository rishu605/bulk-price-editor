/**
 * The catalogue mirror, brought into line with what a run's ledger says it left live.
 *
 * Its own module so the reaper can use it: `run.server` already imports the reaper, and
 * the reaper importing it back would be a cycle.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";

/**
 * The mirror, from a run's ledger: what this run left live on the storefront.
 *
 * A row read back from Shopify says its price is live. Every other row this run may have
 * sent -- failed, written but never read back, or still pending when it stopped -- is
 * unknown, and null is the honest answer: the planner never treats an absent live price as
 * already correct, so the next run writes it, and drift reads null as "we have not looked".
 * Asserting the pre-run price instead is how a revert finds a written row "already at
 * baseline", writes nothing and reports clean with the sale still live; asserting the
 * intended price for an unverified row is how a resume finds it "already correct" (#699).
 *
 * For every run, done before the run or its campaign says it has finished (#906): it used
 * to run row by row after the campaign read Active. For a run that throws after it started
 * writing (#802), which never reaches that point at all. And for a run whose process died,
 * which the reaper reclaims (#903).
 */
export async function settleMirror(runId: string): Promise<void> {
  const landed = Prisma.sql`c."runId" = ${runId} AND c."surfaceKind" = 'BASE' AND c."status" IN ('VERIFIED', 'CLAMPED') AND c."intendedPrice" IS NOT NULL`;
  const unknown = Prisma.sql`c."runId" = ${runId} AND c."surfaceKind" = 'BASE' AND c."status" IN ('PENDING', 'WRITING', 'APPLIED', 'FAILED')`;
  // In UTC, like every Prisma write to these columns. The columns hold no zone, and both
  // `NOW()` and a bare timestamp parameter are converted into the database session's zone
  // on the way in: on one that is not UTC, these rows sat hours off from the ones webhooks
  // and syncs stamp (#911). Converted to UTC explicitly.
  const now = Prisma.sql`(${new Date()}::timestamptz AT TIME ZONE 'UTC')`;

  await prisma.$executeRaw`
    UPDATE "price_surface_entries" e
    SET "livePrice" = c."intendedPrice",
        "liveCompareAt" = CASE WHEN c."intendedCompareAtSet" THEN c."intendedCompareAt" ELSE e."liveCompareAt" END,
        "syncedAt" = ${now}
    FROM "variant_changes" c
    WHERE ${landed} AND e."shopId" = c."shopId" AND e."variantGid" = c."variantGid"
      AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''`;
  // The version of the variant this write produced, as far as webhooks are concerned
  // (#828). The products webhook skips a delivery older than `remoteUpdatedAt`; left where
  // it was, a delayed payload from before this write was applied over it and put the old
  // price back in the mirror -- and a revert planned from that mirror found nothing to do.
  await prisma.$executeRaw`
    UPDATE "variant_index" v
    SET "price" = c."intendedPrice",
        "compareAt" = CASE WHEN c."intendedCompareAtSet" THEN c."intendedCompareAt" ELSE v."compareAt" END,
        "remoteUpdatedAt" = GREATEST(COALESCE(v."remoteUpdatedAt", c."verifiedAt"), COALESCE(c."verifiedAt", v."remoteUpdatedAt")),
        "syncedAt" = ${now}
    FROM "variant_changes" c
    WHERE ${landed} AND v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"`;
  await prisma.$executeRaw`
    UPDATE "price_surface_entries" e
    SET "livePrice" = NULL, "liveCompareAt" = NULL, "syncedAt" = ${now}
    FROM "variant_changes" c
    WHERE ${unknown} AND e."shopId" = c."shopId" AND e."variantGid" = c."variantGid"
      AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''`;
  await prisma.$executeRaw`
    UPDATE "variant_index" v
    SET "price" = NULL, "compareAt" = NULL, "syncedAt" = ${now}
    FROM "variant_changes" c
    WHERE ${unknown} AND v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"`;
}
