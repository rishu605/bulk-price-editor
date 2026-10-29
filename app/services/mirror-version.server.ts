/**
 * Whether the mirror holds a newer version of a variant than a read of its product.
 *
 * One rule, for everything that writes what it read from Shopify over the mirror: the
 * products webhook, and both catalogue syncs. None of them reads at the moment it writes. A
 * webhook is delivered late and out of order; a bulk sync writes its file minutes after
 * Shopify read the products into it; a paginated sync writes a page after reading it. In
 * each window a campaign run can settle its prices in the mirror (`settleMirror`), or a
 * newer webhook can land, and the older read would put the price from before back.
 *
 * The products webhook had this rule (#828, #985) and the syncs did not, so a sync that read
 * a product before a campaign's write and saved it after put the pre-sale price back in the
 * mirror, where What's live and the drift queue read it (#1087). So the rule lives here, in
 * SQL, where a sync's write can carry it as its own condition rather than read first and
 * race what it read.
 *
 * Decided by Shopify's stamp for the product: its `updatedAt` in the read, against the
 * `remoteUpdatedAt` the mirror's row was written at. A price write moves the product's
 * `updatedAt`, not the variant's (#932), so the product's is the version.
 *
 *   - Older than the row: newer in the mirror. The read describes the product as it was.
 *   - The same second, showing a price a landed write of ours replaced in that second:
 *     newer in the mirror (#985). A product written in several calls is stamped the same
 *     second by each, and a read between two of them shows a later call's variant at the
 *     price it is about to replace. A different price in that second is somebody's edit, and
 *     is applied (#932); so is the same price, which changes nothing. The one case this
 *     cannot tell apart is an edit within that second back to the very price the write
 *     replaced.
 *   - A price the mirror has said it does not know since the read was taken: newer in the
 *     mirror (#1107). A run that cannot vouch for a write settles that price to null and
 *     leaves the version from before the run, having no stamp of Shopify's for a write it
 *     never heard back about. By the version alone, a catalogue read begun before the run,
 *     or a webhook delayed from before the write, was no older, and filled the null with
 *     the price from before the run while the sale may have been live. So the null's own
 *     moment, `syncedAt`, is the version here, against when the read was taken: a sync's
 *     start on our clock, a webhook's stamp. A read that began after it fills it.
 *   - Otherwise, and whenever either side has no stamp: not newer, and the read is written.
 *     A mirror nobody has written since the read is exactly what a read is for correcting.
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { LANDED } from "../lib/execution/landed";

/** One variant as a read of its product showed it. */
export interface VariantRead {
  variantGid: string;
  /** The product's `updatedAt` in the read, or null when it carried none. */
  stamp: Date | null;
  /** The price the read showed, in minor units. */
  price: bigint | null;
}

const LANDED_SQL = Prisma.raw(LANDED.map((status) => `'${status}'`).join(", "));

/**
 * The rule, as a SQL condition that is true or false and never null: the `variant_index` row
 * `held` holds a newer version of its variant than a read stamped `read.stamp`, showing
 * `read.price`, and taken at `read.takenAt`.
 *
 * `held` names the row (a table name or alias); `read.stamp` and `read.takenAt` are
 * `timestamp`s in UTC, as the mirror's columns hold them, and `read.price` a `bigint`.
 * `read.takenAt` is the earliest the read can describe the product: a sync's start, before
 * Shopify read anything into it, or a webhook's stamp.
 */
export function heldIsNewer(
  held: Prisma.Sql,
  read: { stamp: Prisma.Sql; price: Prisma.Sql; takenAt: Prisma.Sql },
): Prisma.Sql {
  return Prisma.sql`COALESCE(
    ${held}."remoteUpdatedAt" > ${read.stamp}
    OR (${held}."price" IS NULL AND ${held}."syncedAt" > ${read.takenAt})
    OR (
      ${held}."remoteUpdatedAt" = ${read.stamp}
      AND ${read.price} IS DISTINCT FROM ${held}."price"
      AND EXISTS (
        SELECT 1 FROM "variant_changes" c
        WHERE c."shopId" = ${held}."shopId" AND c."variantGid" = ${held}."variantGid"
          AND c."surfaceKind" = 'BASE' AND c."priceListGid" = ''
          AND c."status" IN (${LANDED_SQL})
          AND c."remoteUpdatedAt" = ${read.stamp}
          AND c."beforePrice" = ${read.price}
          AND c."intendedPrice" <> ${read.price}
      )
    ),
    false)`;
}

/**
 * The variants among `reads` the mirror holds a newer version of: the products webhook's
 * question, asked for a whole delivery at once.
 */
export async function newerInMirror(shopId: string, reads: readonly VariantRead[]): Promise<Set<string>> {
  if (reads.length === 0) return new Set();

  const rows = await prisma.$queryRaw<Array<{ variantGid: string }>>`
    SELECT v."variantGid"
    FROM unnest(
      ${reads.map((read) => read.variantGid)}::text[],
      ${reads.map((read) => read.stamp?.toISOString() ?? null)}::text[],
      ${reads.map((read) => (read.price === null ? null : String(read.price)))}::text[]
    ) AS r("variantGid", stamp, price)
    JOIN "variant_index" v ON v."shopId" = ${shopId} AND v."variantGid" = r."variantGid"
    WHERE ${heldIsNewer(Prisma.raw("v"), {
      stamp: Prisma.raw(`(r.stamp::timestamptz AT TIME ZONE 'UTC')`),
      price: Prisma.raw("r.price::bigint"),
      // A delivery describes its product as it was at its own stamp.
      takenAt: Prisma.raw(`(r.stamp::timestamptz AT TIME ZONE 'UTC')`),
    })}`;
  return new Set(rows.map((row) => row.variantGid));
}
