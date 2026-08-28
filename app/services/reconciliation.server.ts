/**
 * What is live, on every surface, and why.
 *
 * The trust view. A merchant who has just run a sale across four markets wants one page
 * that says: this variant is £15.99 in the UK because Summer Sale controls it, its normal
 * price is £19.99, and nobody has touched it since we wrote it. No competitor offers
 * that, because none of them keeps a ledger that could answer it.
 *
 * Three decisions carry the design.
 *
 * **Rows are variant × surface, not variant.** A variant is not "at" one price; it is at
 * a price per market, and a reconciliation view that collapsed them would be unable to
 * show the case that actually goes wrong — the base price reverted, the Japanese one
 * still on sale.
 *
 * **"Which campaign controls this" is read from the ledger, not recomputed.** Re-running
 * the resolver store-wide would be both slow and a second opinion: it would say which
 * campaign *should* control the price, and this page exists to say which one *did*. When
 * those disagree, the ledger is the evidence and the resolver is the hypothesis.
 *
 * **Everything narrows in SQL.** Filtering fetched rows would mean page 1 of 25 reporting
 * "nothing matches" while the matches sit on page 9, and on a 500K-variant catalogue that
 * is the difference between a feature and a timeout.
 */

import prisma from "../db.server";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { formatMinorUnits } from "../lib/money/format";

const PAGE_SIZE = ROWS_PER_VIEW;

export interface ReconciliationFilters {
  q?: string;
  /** "" for the base surface, a price list gid for a market. */
  priceListGid?: string;
  campaignId?: string;
  /** Live price differs from what the ledger says we wrote. */
  driftedOnly?: boolean;
  /** Live price differs from the baseline — normal during a sale, not otherwise. */
  offBaselineOnly?: boolean;
}

export interface ReconciliationRow {
  variantGid: string;
  title: string;
  sku: string | null;
  /** Empty for the base price; a price list gid for a market. */
  priceListGid: string;
  surface: string;
  currency: string;
  live: string | null;
  baseline: string | null;
  /** The campaign whose write is the most recent verified one for this cell. */
  campaignId: string | null;
  campaignName: string | null;
  /** What that campaign's ledger says it wrote. */
  intended: string | null;
  /**
   * Live disagrees with the ledger.
   *
   * Distinct from being off baseline: off baseline is what a sale *is*, and drift is
   * somebody having changed the price behind us.
   */
  drifted: boolean;
  /** Live differs from the baseline. Expected while a campaign runs. */
  offBaseline: boolean;
  adminUrl: string;
}

export interface ReconciliationPage {
  rows: ReconciliationRow[];
  total: number;
  surfaces: Array<{ priceListGid: string; name: string; currency: string }>;
  campaigns: Array<{ id: string; name: string }>;
  counts: { drifted: number; offBaseline: number };
}

export async function reconcile(
  shopId: string,
  shopDomain: string,
  filters: ReconciliationFilters = {},
  page = 1,
): Promise<ReconciliationPage> {
  const [lists, campaigns] = await Promise.all([
    prisma.priceListRecord.findMany({
      where: { shopId },
      select: { priceListGid: true, name: true, currency: true },
      orderBy: { name: "asc" },
    }),
    prisma.campaign.findMany({
      where: { shopId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
  ]);

  const surfaces = [
    { priceListGid: "", name: "Base price", currency: "" },
    ...lists,
  ];

  // The surface rows themselves. `price_surface_entries` is the one uniform record of
  // "the live value on surface X", which is exactly why base rows were put in it rather
  // than being read from `variant_index`.
  const where: Record<string, unknown> = { shopId };
  if (filters.priceListGid !== undefined && filters.priceListGid !== "any") {
    where.priceListGid = filters.priceListGid;
  }

  if (filters.q) {
    const matching = await prisma.variantIndex.findMany({
      where: {
        shopId,
        deletedAt: null,
        OR: [
          { title: { contains: filters.q, mode: "insensitive" } },
          { sku: { contains: filters.q, mode: "insensitive" } },
          { variantGid: { contains: filters.q } },
        ],
      },
      select: { variantGid: true },
      take: 500,
    });
    where.variantGid = { in: matching.map((row) => row.variantGid) };
  }

  // Drift and off-baseline both compare two tables' values for the same cell, which
  // Prisma cannot express, so they go through raw SQL rather than through the fetched
  // page. Filtering after paging would report "nothing matches" on page 1 while the
  // matches sat on page 9 — and on a 500K-variant catalogue the whole point is that the
  // database does the narrowing.
  if (filters.driftedOnly || filters.offBaselineOnly) {
    const cells = filters.driftedOnly
      ? await driftedCells(shopId)
      : await offBaselineCells(shopId);

    if (cells.length === 0) {
      return { rows: [], total: 0, surfaces, campaigns, counts: await counts(shopId) };
    }
    where.OR = cells.map((cell) => ({
      variantGid: cell.variantGid,
      priceListGid: cell.priceListGid,
    }));
  }

  // Narrowed in SQL, not after paging, for the same reason.
  if (filters.campaignId) {
    const controlled = await prisma.variantChange.findMany({
      where: { shopId, status: "VERIFIED", run: { campaignId: filters.campaignId } },
      select: { variantGid: true },
      distinct: ["variantGid"],
      take: 5_000,
    });
    const gids = controlled.map((row) => row.variantGid);
    where.variantGid = where.variantGid
      ? { in: intersect((where.variantGid as { in: string[] }).in, gids) }
      : { in: gids };
  }

  const [entries, total] = await Promise.all([
    prisma.priceSurfaceEntry.findMany({
      where,
      orderBy: [{ variantGid: "asc" }, { priceListGid: "asc" }],
      skip: (Math.max(1, page) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.priceSurfaceEntry.count({ where }),
  ]);

  const gids = [...new Set(entries.map((entry) => entry.variantGid))];

  const [variants, baselines, ledger] = await Promise.all([
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: gids } },
      select: { variantGid: true, productGid: true, title: true, sku: true },
    }),
    prisma.baseline.findMany({
      where: { shopId, variantGid: { in: gids }, supersededAt: null },
      select: { variantGid: true, priceListGid: true, basePrice: true, currency: true },
    }),
    // The most recent verified write per cell. Ordered so the first row seen for a cell
    // is the newest, which is the one that explains the price now.
    prisma.variantChange.findMany({
      where: { shopId, variantGid: { in: gids }, status: "VERIFIED" },
      orderBy: { verifiedAt: "desc" },
      select: {
        variantGid: true,
        priceListGid: true,
        intendedPrice: true,
        currency: true,
        run: { select: { campaignId: true, campaign: { select: { name: true } } } },
      },
    }),
  ]);

  const variantBy = new Map(variants.map((row) => [row.variantGid, row]));
  const baselineBy = new Map(baselines.map((row) => [key(row.variantGid, row.priceListGid), row]));

  const controllerBy = new Map<string, (typeof ledger)[number]>();
  for (const row of ledger) {
    const cell = key(row.variantGid, row.priceListGid);
    if (!controllerBy.has(cell)) controllerBy.set(cell, row);
  }

  const listBy = new Map(lists.map((list) => [list.priceListGid, list]));

  const rows: ReconciliationRow[] = entries.map((entry) => {
    const cell = key(entry.variantGid, entry.priceListGid);
    const variant = variantBy.get(entry.variantGid);
    const baseline = baselineBy.get(cell);
    const controller = controllerBy.get(cell);
    const currency = entry.currency || baseline?.currency || "USD";

    const live = entry.livePrice === null ? null : Number(entry.livePrice);
    const base = baseline ? Number(baseline.basePrice) : null;
    const intended = controller?.intendedPrice === null || controller?.intendedPrice === undefined
      ? null
      : Number(controller.intendedPrice);

    return {
      variantGid: entry.variantGid,
      title: variant?.title ?? entry.variantGid,
      sku: variant?.sku ?? null,
      priceListGid: entry.priceListGid,
      surface: entry.priceListGid
        ? (listBy.get(entry.priceListGid)?.name ?? entry.priceListGid)
        : "Base price",
      currency,
      live: formatMinorUnits(entry.livePrice, currency),
      baseline: formatMinorUnits(baseline?.basePrice ?? null, currency),
      campaignId: controller?.run.campaignId ?? null,
      campaignName: controller?.run.campaign.name ?? null,
      intended: formatMinorUnits(
        controller?.intendedPrice ?? null,
        controller?.currency || currency,
      ),
      // Only a claim when we actually made one. A variant no campaign has written is
      // not "drifted" — nothing was promised about it.
      drifted: intended !== null && live !== null && intended !== live,
      offBaseline: base !== null && live !== null && base !== live,
      adminUrl: variant
        ? `https://${shopDomain}/admin/products/${variant.productGid.split("/").pop()}`
        : `https://${shopDomain}/admin/products`,
    };
  });

  return { rows, total, surfaces, campaigns, counts: await counts(shopId) };
}

/**
 * Cells where the live price disagrees with what we last verified writing.
 *
 * This is drift in the strict sense: somebody changed the price behind us. A cell no
 * campaign has ever written cannot drift, because nothing was promised about it — hence
 * the join rather than a left join.
 *
 * `DISTINCT ON` picks the newest verified write per cell, which is the one that explains
 * the price now. Postgres-specific and deliberately so: the alternative is a correlated
 * subquery per row.
 */
async function driftedCells(shopId: string) {
  return prisma.$queryRaw<Array<{ variantGid: string; priceListGid: string }>>`
    SELECT e."variantGid", e."priceListGid"
    FROM "price_surface_entries" e
    JOIN (
      SELECT DISTINCT ON (c."variantGid", c."priceListGid")
             c."variantGid", c."priceListGid", c."intendedPrice"
      FROM "variant_changes" c
      WHERE c."shopId" = ${shopId} AND c."status" = 'VERIFIED'
      ORDER BY c."variantGid", c."priceListGid", c."verifiedAt" DESC
    ) w ON w."variantGid" = e."variantGid" AND w."priceListGid" = e."priceListGid"
    WHERE e."shopId" = ${shopId}
      AND e."livePrice" IS NOT NULL
      AND w."intendedPrice" IS NOT NULL
      AND e."livePrice" <> w."intendedPrice"
    LIMIT 5000
  `;
}

/** Cells whose live price differs from their baseline — what a sale looks like. */
async function offBaselineCells(shopId: string) {
  return prisma.$queryRaw<Array<{ variantGid: string; priceListGid: string }>>`
    SELECT e."variantGid", e."priceListGid"
    FROM "price_surface_entries" e
    JOIN "baselines" b
      ON b."variantGid" = e."variantGid"
     AND b."priceListGid" = e."priceListGid"
     AND b."shopId" = e."shopId"
     AND b."supersededAt" IS NULL
    WHERE e."shopId" = ${shopId}
      AND e."livePrice" IS NOT NULL
      AND e."livePrice" <> b."basePrice"
    LIMIT 5000
  `;
}

/**
 * Store-wide totals, not page totals.
 *
 * "12 products have drifted" is the number a merchant needs; "0 on this page" tells them
 * nothing and quietly implies everything is fine.
 */
async function counts(shopId: string) {
  const [drifted, offBaseline] = await Promise.all([
    driftedCells(shopId),
    offBaselineCells(shopId),
  ]);

  return { drifted: drifted.length, offBaseline: offBaseline.length };
}

const key = (variantGid: string, priceListGid: string) => `${variantGid}@${priceListGid}`;

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}
