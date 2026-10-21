/**
 * The catalogue mirror, from rows read off Shopify: one writer for both catalogue syncs.
 *
 * Both syncs write what they read some time after they read it -- the bulk sync once its
 * whole file is built, minutes on a large store; the paginated sync once its page is in. A
 * campaign run that settles its prices in that window (`settleMirror`), or a products
 * webhook that lands in it, leaves the mirror newer than the read. Each sync used to write
 * every row it read regardless, so the price from before the campaign went back into the
 * mirror over the campaign's, and What's live and the drift queue read it until the next
 * webhook or sync (#1087).
 *
 * So a row is written only when the mirror does not hold a newer version of it, by the rule
 * the products webhook decides by (`heldIsNewer`). It is the write's own condition, not a
 * read before it: a check read first is a second window for the same race, and a batch of a
 * thousand rows would pay for it a thousand times.
 *
 * One writer rather than one per sync, because the two writing different columns is a bug
 * this codebase has had twice: the bulk path once wrote no base-surface row at all, so a
 * bulk-imported variant could not be priced, and later dropped `imageUrl` (`sync-parity.test`).
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import type { CatalogRow } from "../lib/catalog/bulk-jsonl";
import type { Money } from "../lib/money/money";
import { heldIsNewer } from "./mirror-version.server";

function minor(money: Money | null): bigint | null {
  return money ? BigInt(money.amount) : null;
}

/**
 * Writes one batch of rows read from Shopify, in one transaction, and says how many the
 * mirror held a newer version of.
 *
 * Three steps:
 *
 *   1. A variant the mirror has never seen gets both its rows, as read. Created first, so
 *      every row read has both by step 2 -- including one whose other row is missing, which
 *      a second pass could not promise. A new row is then rewritten in step 2 with the same
 *      values: a first import's cost, once per variant.
 *   2. Every row read is brought up to the read, `variant_index` and its base-surface row
 *      together, unless the mirror holds a newer version of it. That keeps a campaign's
 *      settled price, a newer webhook's, and a tombstone a deletion stamped; a row nobody
 *      wrote since the read is corrected, which is what a sync is for.
 *   3. A row the mirror kept still takes what only a sync reads: cost, collections and
 *      image. No campaign write or products webhook carries them, so a newer version of the
 *      product says nothing about them, and the read is the newest word there is. Cost
 *      especially: the guardrails price against it, and the variants a campaign just wrote
 *      are the ones most likely to be kept.
 *
 * Steps 2 and 3 are one statement, so the rows step 3 touches are exactly the ones step 2
 * left, under the same locks.
 */
export async function writeCatalogRows(
  shopId: string,
  currency: string,
  rows: readonly CatalogRow[],
): Promise<{ kept: number }> {
  if (rows.length === 0) return { kept: 0 };

  const currencyOf = (row: CatalogRow) => row.price?.currency ?? currency;
  const read = JSON.stringify(
    rows.map((row) => ({
      variantGid: row.variantGid,
      productGid: row.productGid,
      title: row.title,
      sku: row.sku,
      barcode: row.barcode,
      // Strings, so a minor-unit amount never passes through a JSON number on its way in.
      price: row.price ? String(row.price.amount) : null,
      compareAt: row.compareAt ? String(row.compareAt.amount) : null,
      cost: row.cost ? String(row.cost.amount) : null,
      currency: currencyOf(row),
      inventoryQty: row.inventoryQty,
      status: row.status,
      vendor: row.vendor,
      productType: row.productType,
      tags: row.tags,
      collections: row.collections,
      imageUrl: row.imageUrl,
      isGiftCard: row.isGiftCard,
      remoteUpdatedAt: row.remoteUpdatedAt?.toISOString() ?? null,
    })),
  );
  // In UTC, as every write to these columns is (#911).
  const now = Prisma.sql`(${new Date()}::timestamptz AT TIME ZONE 'UTC')`;

  const [, , counted] = await prisma.$transaction([
    prisma.variantIndex.createMany({
      data: rows.map((row) => ({
        shopId,
        variantGid: row.variantGid,
        productGid: row.productGid,
        title: row.title,
        sku: row.sku,
        barcode: row.barcode,
        price: minor(row.price),
        compareAt: minor(row.compareAt),
        cost: minor(row.cost),
        currency: currencyOf(row),
        inventoryQty: row.inventoryQty,
        status: row.status,
        vendor: row.vendor,
        productType: row.productType,
        tags: row.tags,
        collections: row.collections,
        imageUrl: row.imageUrl,
        remoteUpdatedAt: row.remoteUpdatedAt,
        isGiftCard: row.isGiftCard,
      })),
      skipDuplicates: true,
    }),
    // The base-surface row, in the same transaction as the index row. Baselines are
    // captured from it, so a variant mirrored without one is counted and listed and cannot
    // be priced -- which the bulk path once did to every variant it imported.
    prisma.priceSurfaceEntry.createMany({
      data: rows.map((row) => ({
        shopId,
        variantGid: row.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: currencyOf(row),
        livePrice: minor(row.price),
        liveCompareAt: minor(row.compareAt),
      })),
      skipDuplicates: true,
    }),
    prisma.$queryRaw<Array<{ kept: number }>>`
      WITH incoming AS (
        SELECT i.*, (i."remoteUpdatedAt" AT TIME ZONE 'UTC') AS stamp
        FROM jsonb_to_recordset(${read}::jsonb) AS i(
          "variantGid" text, "productGid" text, "title" text, "sku" text, "barcode" text,
          "price" bigint, "compareAt" bigint, "cost" bigint, "currency" text,
          "inventoryQty" integer, "status" text, "vendor" text, "productType" text,
          "tags" text[], "collections" text[], "imageUrl" text, "isGiftCard" boolean,
          "remoteUpdatedAt" timestamptz
        )
      ),
      written AS (
        UPDATE "variant_index" v
        SET "productGid" = i."productGid",
            "title" = i."title",
            "sku" = i."sku",
            "barcode" = i."barcode",
            "price" = i."price",
            "compareAt" = i."compareAt",
            "cost" = i."cost",
            "currency" = i."currency",
            "inventoryQty" = i."inventoryQty",
            "status" = i."status"::"VariantStatus",
            "vendor" = i."vendor",
            "productType" = i."productType",
            "tags" = i."tags",
            "collections" = i."collections",
            "imageUrl" = i."imageUrl",
            "isGiftCard" = i."isGiftCard",
            "remoteUpdatedAt" = i.stamp,
            -- A variant reappearing after deletion clears its tombstone.
            "deletedAt" = NULL,
            "syncedAt" = ${now}
        FROM incoming i
        WHERE v."shopId" = ${shopId} AND v."variantGid" = i."variantGid"
          AND NOT ${heldIsNewer(Prisma.raw("v"), { stamp: Prisma.raw("i.stamp"), price: Prisma.raw(`i."price"`) })}
        RETURNING v."variantGid"
      ),
      surfaced AS (
        UPDATE "price_surface_entries" e
        SET "currency" = i."currency",
            "livePrice" = i."price",
            "liveCompareAt" = i."compareAt",
            "syncedAt" = ${now}
        FROM incoming i JOIN written w ON w."variantGid" = i."variantGid"
        WHERE e."shopId" = ${shopId} AND e."variantGid" = i."variantGid"
          AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''
        RETURNING 1
      ),
      kept AS (
        UPDATE "variant_index" v
        SET "cost" = i."cost",
            "collections" = i."collections",
            "imageUrl" = i."imageUrl"
        FROM incoming i
        WHERE v."shopId" = ${shopId} AND v."variantGid" = i."variantGid"
          AND i."variantGid" NOT IN (SELECT "variantGid" FROM written)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM kept)::int AS kept`,
  ]);

  return { kept: counted[0]?.kept ?? 0 };
}
