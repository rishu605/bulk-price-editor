/**
 * Answering "why is this variant priced the way it is?" without a database client.
 *
 * That question arrives in support tickets constantly for competitors, and the honest
 * answer there is usually a shrug. Ours should be a link: every baseline the variant has
 * ever had, where each came from, who captured it, and how it compares to what the
 * storefront shows right now.
 *
 * Built as a read model rather than a screen, because the merchant-facing reconciliation
 * view (P5.6) is the same question asked more politely — and that view should be mostly
 * assembly rather than a second implementation free to disagree with this one.
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { formatMinorUnits } from "../lib/money/format";
import { astToWhere, type FilterAst } from "./segments.server";

export interface BaselineFilters {
  q?: string;
  vendor?: string;
  collection?: string;
  source?: string;
  /** Only variants whose live price differs from their baseline. */
  divergedOnly?: boolean;
}

export interface BaselineRow {
  variantGid: string;
  productGid: string;
  title: string;
  sku: string | null;
  vendor: string | null;
  /** Formatted for display; the raw minor units stay on the server. */
  baseline: string | null;
  live: string | null;
  source: string | null;
  capturedAt: string | null;
  /** Live differs from baseline. Expected during a campaign, a warning outside one. */
  diverged: boolean;
  /** Deep link to the product in Shopify admin. */
  adminUrl: string;
}

export interface BaselinePage {
  rows: BaselineRow[];
  total: number;
  vendors: string[];
  sources: readonly string[];
}

const PAGE_SIZE = ROWS_PER_VIEW;

export async function browseBaselines(
  shopId: string,
  shopDomain: string,
  filters: BaselineFilters = {},
  page = 1,
): Promise<BaselinePage> {
  const ast: FilterAst = { groups: [] };
  const where = astToWhere(shopId, ast) as Record<string, unknown>;

  if (filters.vendor) where.vendor = { equals: filters.vendor, mode: "insensitive" };
  if (filters.collection) where.collections = { has: filters.collection };
  if (filters.q) {
    // Title or SKU, because support is handed one or the other and rarely knows which.
    where.OR = [
      { title: { contains: filters.q, mode: "insensitive" } },
      { sku: { contains: filters.q, mode: "insensitive" } },
      { variantGid: { contains: filters.q } },
    ];
  }

  // Both of these have to narrow the query rather than the page. Filtering the fetched
  // rows afterwards means page 1 of 25 reports "nothing matches" while the matches sit
  // on page 9 — a filter that lies about an empty catalogue is worse than no filter.
  if (filters.source || filters.divergedOnly) {
    const matching = await matchingVariantGids(shopId, filters);
    if (matching.length === 0) {
      return { rows: [], total: 0, vendors: [], sources: SOURCES };
    }
    where.variantGid = { in: matching };
  }

  const [variants, total, vendors] = await Promise.all([
    prisma.variantIndex.findMany({
      where,
      orderBy: { title: "asc" },
      skip: (Math.max(1, page) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        variantGid: true,
        productGid: true,
        title: true,
        sku: true,
        vendor: true,
        currency: true,
      },
    }),
    prisma.variantIndex.count({ where }),
    prisma.variantIndex.findMany({
      where: { shopId, deletedAt: null, vendor: { not: null } },
      distinct: ["vendor"],
      select: { vendor: true },
      take: 50,
    }),
  ]);

  const gids = variants.map((v) => v.variantGid);

  const [baselines, entries] = await Promise.all([
    prisma.baseline.findMany({
      where: { shopId, variantGid: { in: gids }, surfaceKind: "BASE", supersededAt: null },
      select: { variantGid: true, basePrice: true, currency: true, source: true, capturedAt: true },
    }),
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, variantGid: { in: gids }, surfaceKind: "BASE", priceListGid: "" },
      select: { variantGid: true, livePrice: true, currency: true },
    }),
  ]);

  const baselineBy = new Map(baselines.map((b) => [b.variantGid, b]));
  const liveBy = new Map(entries.map((e) => [e.variantGid, e]));

  const rows: BaselineRow[] = variants.map((variant) => {
    const baseline = baselineBy.get(variant.variantGid);
    const live = liveBy.get(variant.variantGid);
    const currency = baseline?.currency ?? live?.currency ?? variant.currency ?? "USD";

    return {
      variantGid: variant.variantGid,
      productGid: variant.productGid,
      title: variant.title ?? variant.variantGid,
      sku: variant.sku,
      vendor: variant.vendor,
      baseline: formatMinorUnits(baseline?.basePrice ?? null, currency),
      live: formatMinorUnits(live?.livePrice ?? null, currency),
      source: baseline?.source ?? null,
      capturedAt: baseline?.capturedAt.toISOString() ?? null,
      diverged:
        baseline !== undefined &&
        live?.livePrice !== undefined &&
        live.livePrice !== null &&
        live.livePrice !== baseline.basePrice,
      adminUrl: adminProductUrl(shopDomain, variant.productGid),
    };
  });

  return {
    rows,
    total,
    vendors: vendors.map((v) => v.vendor!).filter(Boolean).sort(),
    sources: SOURCES,
  };
}

export const SOURCES = [
  "INSTALL_CAPTURE",
  "RECAPTURE",
  "CSV_IMPORT",
  "DRIFT_ADOPTION",
  "AUTO_ENROLL",
] as const;

/**
 * Variants matching the filters that live outside `variant_index`.
 *
 * Divergence is a comparison between two tables and source lives on a third, so both
 * are resolved to a set of ids first and folded into the main query. Capped, because an
 * unbounded `IN` over half a million ids is not a query anybody wants to have written.
 */
async function matchingVariantGids(
  shopId: string,
  filters: BaselineFilters,
  limit = 10_000,
): Promise<string[]> {
  if (filters.divergedOnly) {
    const rows = await prisma.$queryRaw<Array<{ variantGid: string }>>`
      SELECT b."variantGid"
      FROM "baselines" b
      JOIN "price_surface_entries" e
        ON e."shopId" = b."shopId"
       AND e."variantGid" = b."variantGid"
       AND e."surfaceKind" = 'BASE'
       AND e."priceListGid" = ''
      WHERE b."shopId" = ${shopId}
        AND b."supersededAt" IS NULL
        AND b."surfaceKind" = 'BASE'
        AND e."livePrice" IS NOT NULL
        AND e."livePrice" <> b."basePrice"
        ${filters.source ? Prisma.sql`AND b."source"::text = ${filters.source}` : Prisma.empty}
      LIMIT ${limit}
    `;
    return rows.map((row) => row.variantGid);
  }

  const rows = await prisma.baseline.findMany({
    where: {
      shopId,
      supersededAt: null,
      surfaceKind: "BASE",
      source: filters.source as never,
    },
    select: { variantGid: true },
    take: limit,
  });
  return rows.map((row) => row.variantGid);
}

export interface BaselineHistoryEntry {
  price: string;
  compareAt: string | null;
  source: string;
  capturedBy: string | null;
  capturedAt: string;
  supersededAt: string | null;
  current: boolean;
}

/**
 * Every baseline this variant has ever had.
 *
 * The whole answer to "why is it priced like this". Append-only storage is what makes it
 * possible: a capture supersedes rather than overwrites, so the reference price a
 * campaign used six weeks ago is still there to point at.
 */
export async function baselineHistory(
  shopId: string,
  variantGid: string,
): Promise<BaselineHistoryEntry[]> {
  const rows = await prisma.baseline.findMany({
    where: { shopId, variantGid, surfaceKind: "BASE" },
    orderBy: { capturedAt: "desc" },
    take: 50,
  });

  return rows.map((row) => ({
    price: formatMinorUnits(row.basePrice, row.currency) ?? "—",
    compareAt: formatMinorUnits(row.baseCompareAt, row.currency),
    source: row.source,
    capturedBy: row.capturedBy,
    capturedAt: row.capturedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    current: row.supersededAt === null,
  }));
}

/**
 * Deep link into Shopify admin.
 *
 * The point of the page is that support does not have to leave it to answer the
 * question — but when they do have to leave it, they should land on the product rather
 * than on a search box.
 */
export function adminProductUrl(shopDomain: string, productGid: string): string {
  const id = productGid.split("/").pop() ?? "";
  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/products/${id}`;
}
