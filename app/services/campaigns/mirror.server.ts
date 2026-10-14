/**
 * The catalogue mirror, brought into line with what a run's ledger says it left live.
 *
 * Its own module so the reaper can use it: `run.server` already imports the reaper, and
 * the reaper importing it back would be a cycle.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { chunk } from "../../lib/db/chunk";
import type { MarketPriceRow, MarketWriteResult } from "../../lib/execution/market-executor";

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
  //
  // Shopify's own timestamp for the write where the row has it (#932). The webhook's
  // `updated_at` is on Shopify's clock and to the second, and our read-back time ran ahead
  // of it: an edit made a second after the write compared older and was dropped. Our
  // verifiedAt only for rows written before that was recorded.
  await prisma.$executeRaw`
    UPDATE "variant_index" v
    SET "price" = c."intendedPrice",
        "compareAt" = CASE WHEN c."intendedCompareAtSet" THEN c."intendedCompareAt" ELSE v."compareAt" END,
        "remoteUpdatedAt" = GREATEST(
          COALESCE(v."remoteUpdatedAt", c."remoteUpdatedAt", c."verifiedAt"),
          COALESCE(c."remoteUpdatedAt", c."verifiedAt", v."remoteUpdatedAt")
        ),
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

  // Market prices this run sent and never heard back about (#779). Each market write
  // mirrors its own outcome as it lands (`mirrorMarketWrite`), so what is left here are
  // rows a run stopped part-way through: it threw, or its process died. Shopify may hold
  // them, so the mirror says it does not know. Failed rows are not among them -- the write
  // that failed them already said what it knew, and a market-wide percentage that was
  // refused wrote no price at all.
  const unsettled = await prisma.variantChange.findMany({
    where: { runId, surfaceKind: { not: "BASE" }, priceListGid: { not: "" }, status: { in: ["PENDING", "WRITING", "APPLIED"] } },
    select: { shopId: true, variantGid: true, priceListGid: true, currency: true },
  });
  const byList = new Map<string, { shopId: string; currency: string; variantGids: string[] }>();
  for (const row of unsettled) {
    const list = byList.get(row.priceListGid) ?? { shopId: row.shopId, currency: row.currency, variantGids: [] };
    list.variantGids.push(row.variantGid);
    byList.set(row.priceListGid, list);
  }
  for (const [priceListGid, list] of byList) {
    await markUnknown(list.shopId, { priceListGid, currency: list.currency }, list.variantGids);
  }
}

/**
 * A market's mirror, from a fixed-price write that just came back (#779).
 *
 * Only the base surface used to be mirrored from a run, so a market price the app wrote was
 * unknown to the mirror until the next markets sync. What's live, which lists the mirror,
 * showed no row for it -- a sale price stranded in the United States catalogue was invisible
 * on the one page that promises every price on every surface -- and, on a list whose prices
 * the sync had mirrored before the campaign, it read the old price against the campaign's
 * ledger and called the campaign's own write drift.
 *
 * Written the way `settleMirror` writes a base price, and the way the sync would read it
 * back. A verified row is a fixed price on the list now: its row holds the price, created if
 * the list had none. Its strike-through is what the write decided -- set, or cleared -- and
 * is left alone where the write left it alone. Any other row may or may not be on the list,
 * so its price is null: "we have not looked", never the price from before the write.
 *
 * Called before the ledger records the outcome, so a run that dies in between leaves its
 * rows unsettled and `settleMirror` then marks them unknown, rather than the ledger saying
 * verified over a mirror still holding the old price.
 *
 * Stamped with this process's clock, like the sync. A sync that read the list before this
 * write leaves the newer row alone, and its sweep of the rows it did not see spares it too.
 */
export async function mirrorMarketWrite(
  shopId: string,
  list: { priceListGid: string; currency: string },
  sent: readonly MarketPriceRow[],
  result: MarketWriteResult,
): Promise<void> {
  if (!list.priceListGid || sent.length === 0) return;

  const verified = new Set(result.rows.filter((row) => row.status === "verified").map((row) => row.variantGid));
  const landed = sent.filter((row) => verified.has(row.variantGid));
  const unknown = sent.filter((row) => !verified.has(row.variantGid)).map((row) => row.variantGid);

  if (landed.length > 0) {
    const kind = await surfaceKindOf(shopId, list.priceListGid);
    const now = new Date();
    const stamp = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;

    for (const batch of chunk(landed)) {
      // Three states, as Shopify keeps them: a strike-through set or cleared by this write,
      // and one the write left as the list had it. Two statements rather than a flag per
      // row, so neither has to say which it is.
      const decided = batch.filter((row) => row.compareAt !== undefined);
      const left = batch.filter((row) => row.compareAt === undefined);

      if (decided.length > 0) {
        await prisma.$executeRaw`
          UPDATE "price_surface_entries" e
          SET "livePrice" = v.price::bigint,
              "liveCompareAt" = NULLIF(v.compare, '')::bigint,
              "currency" = ${list.currency},
              "syncedAt" = ${stamp}
          FROM unnest(
            ${decided.map((row) => row.variantGid)}::text[],
            ${decided.map((row) => String(row.price.amount))}::text[],
            ${decided.map((row) => (row.compareAt ? String(row.compareAt.amount) : ""))}::text[]
          ) AS v(gid, price, compare)
          WHERE e."shopId" = ${shopId} AND e."priceListGid" = ${list.priceListGid} AND e."variantGid" = v.gid`;
      }
      if (left.length > 0) {
        await prisma.$executeRaw`
          UPDATE "price_surface_entries" e
          SET "livePrice" = v.price::bigint,
              "currency" = ${list.currency},
              "syncedAt" = ${stamp}
          FROM unnest(
            ${left.map((row) => row.variantGid)}::text[],
            ${left.map((row) => String(row.price.amount))}::text[]
          ) AS v(gid, price)
          WHERE e."shopId" = ${shopId} AND e."priceListGid" = ${list.priceListGid} AND e."variantGid" = v.gid`;
      }

      // The rows the list had no fixed price for until now. A strike-through this write did
      // not set is none: a fixed price added without one has none.
      if (kind) {
        await prisma.priceSurfaceEntry.createMany({
          data: batch.map((row) => ({
            shopId,
            variantGid: row.variantGid,
            surfaceKind: kind,
            priceListGid: list.priceListGid,
            currency: list.currency,
            livePrice: BigInt(row.price.amount),
            liveCompareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
            syncedAt: now,
          })),
          skipDuplicates: true,
        });
      }
    }
  }

  await markUnknown(shopId, list, unknown);
}

/**
 * A market's mirror, from a revert that deleted fixed prices (#779).
 *
 * A deleted fixed price has no row, which is how the sync mirrors a list: only the prices
 * somebody set are stored, and the rest follow the list's rule. Left in place, the row went
 * on claiming the campaign's sale price until the next sync -- on What's live, and to a
 * recapture or a B2B plan reading it as the merchant's own price (#732). A delete that
 * failed may or may not have happened, so those rows are unknown.
 */
export async function mirrorMarketDelete(
  shopId: string,
  list: { priceListGid: string; currency: string },
  result: MarketWriteResult,
): Promise<void> {
  if (!list.priceListGid) return;

  const gone = result.rows.filter((row) => row.status === "verified").map((row) => row.variantGid);
  for (const batch of chunk(gone)) {
    await prisma.priceSurfaceEntry.deleteMany({
      where: { shopId, priceListGid: list.priceListGid, variantGid: { in: batch } },
    });
  }

  await markUnknown(
    shopId,
    list,
    result.rows.filter((row) => row.status !== "verified").map((row) => row.variantGid),
  );
}

/**
 * Fixed prices on a list we cannot vouch for: a null price, the mirror's "we have not
 * looked". Created where the list had no row, because no row is a definite claim on this
 * surface -- "no fixed price here" -- and that is exactly what an unconfirmed write cannot
 * support. Every reader of a market row already skips a null price, and the next sync
 * replaces it with what Shopify holds or removes it.
 */
async function markUnknown(
  shopId: string,
  list: { priceListGid: string; currency: string },
  variantGids: readonly string[],
): Promise<void> {
  if (!list.priceListGid || variantGids.length === 0) return;

  const kind = await surfaceKindOf(shopId, list.priceListGid);
  const now = new Date();

  for (const batch of chunk(variantGids)) {
    await prisma.priceSurfaceEntry.updateMany({
      where: { shopId, priceListGid: list.priceListGid, variantGid: { in: batch } },
      data: { livePrice: null, liveCompareAt: null, syncedAt: now },
    });
    if (kind) {
      await prisma.priceSurfaceEntry.createMany({
        data: batch.map((variantGid) => ({
          shopId,
          variantGid,
          surfaceKind: kind,
          priceListGid: list.priceListGid,
          currency: list.currency,
          livePrice: null,
          liveCompareAt: null,
          syncedAt: now,
        })),
        skipDuplicates: true,
      });
    }
  }
}

/**
 * Which surface a list's rows are filed under, as the markets sync filed it.
 *
 * Asked of the list's own record rather than of the ledger, which calls every list's rows
 * MARKET: a B2B list's row created as MARKET would be a second row for the same price, beside
 * the one the sync keeps. Null for a list the sync no longer knows about, which gets no new
 * rows -- the sync removed that list's rows when it went.
 */
async function surfaceKindOf(shopId: string, priceListGid: string): Promise<"MARKET" | "B2B" | null> {
  const record = await prisma.priceListRecord.findUnique({
    where: { shopId_priceListGid: { shopId, priceListGid } },
    select: { surfaceKind: true },
  });
  if (!record) return null;
  return record.surfaceKind === "B2B" ? "B2B" : "MARKET";
}
