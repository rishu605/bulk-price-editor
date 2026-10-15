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
 * The ledger names who *wrote* a price, which is not always who it is because of. A revert
 * writes the price without its campaign -- the baseline, or another campaign's price -- and
 * is ledgered under the campaign being taken out; and a campaign that has let a variant go
 * or ended no longer puts a price anywhere. So the campaign shown is the newest write by a
 * campaign still pricing the cell; a revert's write is nobody's, and neither are the writes
 * it undid (#779).
 *
 * **Everything narrows in SQL.** Filtering fetched rows would mean page 1 of 25 reporting
 * "nothing matches" while the matches sit on page 9, and on a 500K-variant catalogue that
 * is the difference between a feature and a timeout.
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { PRICES_MAY_BE_LIVE } from "../lib/lifecycle/transitions";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { formatMinorUnits } from "../lib/money/format";
import { LANDED } from "../lib/execution/landed";
import { labelled, priceListLabel } from "../lib/markets/display-name";
import { BASE_SURFACE } from "../lib/reporting/export-filters";
import { inheritedBy, inheritorsOf } from "./campaigns/handover.server";

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
  /** Off baseline with no campaign behind it: a price changed outside the app (#745). */
  staleBaselineOnly?: boolean;
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
  /**
   * The campaign this price is because of: the newest verified write to the cell by a
   * campaign that may still have prices live, has not excluded the variant, and has not
   * reverted the cell since (#779). Null when no such campaign wrote it.
   */
  campaignId: string | null;
  campaignName: string | null;
  /** What the newest verified write to this cell put there, whichever run made it. */
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
  /** `value` is what the Surface filter submits: a price list gid, or `BASE_SURFACE`. */
  surfaces: Array<{ value: string; name: string; currency: string }>;
  campaigns: Array<{ id: string; name: string }>;
  counts: { drifted: number; offBaseline: number; staleBaseline: number };
}

export async function reconcile(
  shopId: string,
  shopDomain: string,
  filters: ReconciliationFilters = {},
  page = 1,
  /** Rows a page. The screen's by default; an export reads all of them in larger pages (#819). */
  pageSize = PAGE_SIZE,
): Promise<ReconciliationPage> {
  const [lists, campaigns] = await Promise.all([
    prisma.priceListRecord.findMany({
      where: { shopId },
      select: { priceListGid: true, name: true, catalogTitle: true, surfaceKind: true, currency: true },
      orderBy: { name: "asc" },
    }).then((rows) => rows.map(labelled)),
    prisma.campaign.findMany({
      where: { shopId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
  ]);

  // Named through `priceListLabel`, never Shopify's own name for a market's list, which is
  // `pricing_by_market.19853246698_1786915628` (#722, as #642 did for the editor).
  const surfaces = [
    { value: BASE_SURFACE, name: "Base price", currency: "" },
    ...lists
      .map((list) => ({ value: list.priceListGid, name: priceListLabel(list), currency: list.currency }))
      .sort((a, b) => a.name.localeCompare(b.name)),
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
  if (filters.driftedOnly || filters.offBaselineOnly || filters.staleBaselineOnly) {
    const cells = filters.driftedOnly
      ? await driftedCells(shopId)
      : filters.staleBaselineOnly
        ? await staleBaselineCells(shopId)
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
    const [controlled, inherited] = await Promise.all([
      prisma.variantChange.findMany({
        where: { shopId, status: { in: [...LANDED] }, run: { campaignId: filters.campaignId } },
        select: { variantGid: true },
        distinct: ["variantGid"],
        take: 5_000,
      }),
      // And the prices another campaign's revert handed it, which it never wrote (#1043).
      inheritedBy(shopId, filters.campaignId),
    ]);
    const gids = [...new Set([...controlled.map((row) => row.variantGid), ...inherited.keys()])];
    where.variantGid = where.variantGid
      ? { in: intersect((where.variantGid as { in: string[] }).in, gids) }
      : { in: gids };
  }

  const [entries, total] = await Promise.all([
    prisma.priceSurfaceEntry.findMany({
      where,
      orderBy: [{ variantGid: "asc" }, { priceListGid: "asc" }],
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
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
    // The verified writes per cell, newest first: the first row seen for a cell is what we
    // last put there, and the first one by a campaign still pricing it is why.
    prisma.variantChange.findMany({
      where: { shopId, variantGid: { in: gids }, status: { in: [...LANDED] } },
      orderBy: { verifiedAt: "desc" },
      select: {
        variantGid: true,
        priceListGid: true,
        intendedPrice: true,
        currency: true,
        run: { select: { kind: true, campaignId: true } },
      },
    }),
  ]);

  const variantBy = new Map(variants.map((row) => [row.variantGid, row]));
  const baselineBy = new Map(baselines.map((row) => [key(row.variantGid, row.priceListGid), row]));

  const writers = await prisma.campaign.findMany({
    where: { shopId, id: { in: [...new Set(ledger.map((row) => row.run.campaignId))] } },
    select: { id: true, name: true, status: true, excludedVariantGids: true },
  });
  const campaignBy = new Map(writers.map((campaign) => [campaign.id, campaign]));

  // A write is the reason for a price only while its campaign still prices that variant
  // (#779). Not a revert's: it wrote the price without its campaign -- "Revert this variant"
  // left a variant at its baseline "because of" the sale that had just let it go. Nor that
  // campaign's own earlier writes to the cell, which the revert undid. Not a campaign that
  // has excluded the variant since, which its write still names. And not one whose prices
  // cannot be live any more: an ended sale explains nothing on the storefront.
  const stillPricing = (row: (typeof ledger)[number]) => {
    const campaign = campaignBy.get(row.run.campaignId);
    return (
      campaign !== undefined &&
      PRICES_MAY_BE_LIVE.has(campaign.status) &&
      !campaign.excludedVariantGids.includes(row.variantGid)
    );
  };

  const writerBy = new Map<string, (typeof ledger)[number]>();
  const causeBy = new Map<string, { campaignId: string; name: string }>();
  // Per cell, the campaigns a newer revert has taken out of it.
  const undoneBy = new Map<string, Set<string>>();
  for (const row of ledger) {
    const cell = key(row.variantGid, row.priceListGid);
    if (!writerBy.has(cell)) writerBy.set(cell, row);
    if (causeBy.has(cell)) continue;

    const undone = undoneBy.get(cell) ?? new Set<string>();
    if (row.run.kind === "REVERT") {
      undoneBy.set(cell, undone.add(row.run.campaignId));
    } else if (!undone.has(row.run.campaignId) && stillPricing(row)) {
      causeBy.set(cell, { campaignId: row.run.campaignId, name: campaignBy.get(row.run.campaignId)!.name });
    }
  }

  // A base price another campaign's revert handed over (#998): the newest write is that
  // revert's, and the campaign it went to never wrote the cell, so nothing above names it.
  // Asked of the planner, as drift detection asks it (#1043).
  const handedOver = new Map<string, bigint>();
  for (const [cell, row] of writerBy) {
    if (causeBy.has(cell) || row.run.kind !== "REVERT" || row.priceListGid !== "" || row.intendedPrice === null) continue;
    handedOver.set(row.variantGid, row.intendedPrice);
  }
  for (const [variantGid, campaign] of await inheritorsOf(shopId, handedOver)) {
    causeBy.set(key(variantGid, ""), { campaignId: campaign.id, name: campaign.name });
  }

  const listBy = new Map(lists.map((list) => [list.priceListGid, list]));

  const rows: ReconciliationRow[] = entries.map((entry) => {
    const cell = key(entry.variantGid, entry.priceListGid);
    const variant = variantBy.get(entry.variantGid);
    const baseline = baselineBy.get(cell);
    const controller = writerBy.get(cell);
    const cause = causeBy.get(cell);
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
        ? priceListLabel(listBy.get(entry.priceListGid) ?? { name: "", surfaceKind: entry.surfaceKind })
        : "Base price",
      currency,
      live: formatMinorUnits(entry.livePrice, currency),
      baseline: formatMinorUnits(baseline?.basePrice ?? null, currency),
      campaignId: cause?.campaignId ?? null,
      campaignName: cause?.name ?? null,
      intended: formatMinorUnits(
        controller?.intendedPrice ?? null,
        controller?.currency || currency,
      ),
      // Only a claim when we actually made one. A variant no campaign has written is
      // not "drifted" — nothing was promised about it.
      // Not once its writer has excluded the variant (#1003), the same rule as `driftedFrom`.
      drifted:
        intended !== null &&
        live !== null &&
        intended !== live &&
        !campaignBy.get(controller!.run.campaignId)?.excludedVariantGids.includes(entry.variantGid),
      offBaseline: base !== null && live !== null && base !== live,
      adminUrl: variant
        ? `https://${shopDomain}/admin/products/${variant.productGid.split("/").pop()}`
        : `https://${shopDomain}/admin/products`,
    };
  });

  return { rows, total, surfaces, campaigns, counts: await counts(shopId) };
}

/**
 * The cells where the live price disagrees with what we last verified writing.
 *
 * This is drift in the strict sense: somebody changed the price behind us. A cell no
 * campaign has ever written cannot drift, because nothing was promised about it -- hence
 * the join rather than a left join.
 *
 * `DISTINCT ON` picks the newest verified write per cell, which is the one that explains
 * the price now. Postgres-specific and deliberately so: the alternative is a correlated
 * subquery per row. `variant_changes_landed_lookup` exists to serve that ordering; without
 * it Postgres sorts the shop's whole verified ledger and spills to disk.
 *
 * A fragment rather than a whole query, because two callers ask about the same set and
 * must not be able to disagree about what it contains -- one lists the cells to filter a
 * page by, the other counts them for the badge. Definitions that get restated are how a
 * page ends up saying "3 drifted" above a table showing four.
 */
export function driftedFrom(shopId: string): Prisma.Sql {
  // Not a cell whose writer has excluded the variant since (#1003): "leave the merchant's
  // edit" let that price go, so a kept edit is the merchant's price, not one behind our back.
  return Prisma.sql`
    FROM "price_surface_entries" e
    JOIN (
      SELECT DISTINCT ON (c."variantGid", c."priceListGid")
             c."variantGid", c."priceListGid", c."intendedPrice",
             c."variantGid" = ANY(k."excludedVariantGids") AS "excluded"
      FROM "variant_changes" c
      JOIN "campaign_runs" r ON r."id" = c."runId"
      JOIN "campaigns" k ON k."id" = r."campaignId"
      WHERE c."shopId" = ${shopId} AND c."status" IN ('VERIFIED', 'CLAMPED')
      ORDER BY c."variantGid", c."priceListGid", c."verifiedAt" DESC
    ) w ON w."variantGid" = e."variantGid" AND w."priceListGid" = e."priceListGid"
    WHERE e."shopId" = ${shopId}
      AND e."livePrice" IS NOT NULL
      AND w."intendedPrice" IS NOT NULL
      AND e."livePrice" <> w."intendedPrice"
      AND NOT w."excluded"
  `;
}

/** The same for cells whose live price differs from their baseline -- what a sale looks like. */
export function offBaselineFrom(shopId: string): Prisma.Sql {
  return Prisma.sql`
    FROM "price_surface_entries" e
    JOIN "baselines" b
      ON b."variantGid" = e."variantGid"
     AND b."priceListGid" = e."priceListGid"
     AND b."shopId" = e."shopId"
     AND b."supersededAt" IS NULL
    WHERE e."shopId" = ${shopId}
      AND e."livePrice" IS NOT NULL
      AND e."livePrice" <> b."basePrice"
  `;
}

/**
 * Cells off their baseline that no running campaign put there (#745).
 *
 * Off baseline is what a sale looks like -- but only when a campaign that may still have
 * prices live wrote that cell. Without one, somebody changed the price outside the app
 * while nothing was running. Drift detection only covers cells a live campaign controls,
 * and nothing else updates a baseline, so the baseline is simply out of date: the next
 * sale discounts from the old price, and ending it writes the old price back.
 *
 * The same fragment feeds What's live, Home and the previews, so "3 changed outside a
 * campaign" in one place is never four in another.
 */
export function staleBaselineFrom(
  shopId: string,
  options: { variantGids?: readonly string[]; baseOnly?: boolean } = {},
): Prisma.Sql {
  const live = Prisma.join([...PRICES_MAY_BE_LIVE].map((state) => Prisma.sql`${state}::"CampaignStatus"`));
  return Prisma.sql`
    ${offBaselineFrom(shopId)}
      ${options.variantGids ? Prisma.sql`AND e."variantGid" = ANY(${[...options.variantGids]})` : Prisma.empty}
      ${options.baseOnly ? Prisma.sql`AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''` : Prisma.empty}
      AND NOT EXISTS (
        SELECT 1
        FROM "variant_changes" c
        JOIN "campaign_runs" r ON r."id" = c."runId"
        JOIN "campaigns" k ON k."id" = r."campaignId"
        WHERE c."shopId" = e."shopId"
          AND c."variantGid" = e."variantGid"
          AND c."priceListGid" = e."priceListGid"
          AND c."status" IN ('VERIFIED', 'CLAMPED')
          AND k."status" IN (${live})
          -- A live campaign that has let this variant go did not put its price there (#1003).
          AND NOT (c."variantGid" = ANY(k."excludedVariantGids"))
      )
      AND NOT ${writtenByRevert}
  `;
}

/**
 * The cell `e` shows what one of our reverts wrote there, and nothing has written over it
 * since (#1043). Off baseline, that is another campaign's price, handed over when a higher
 * one ended (#998) -- ledgered under the ended campaign's revert, so no running campaign's
 * row covers it. It was not changed outside the app, and a recapture taking it for the
 * variant's normal price would make the sale its own baseline (rule 1).
 */
const writtenByRevert = Prisma.sql`
  EXISTS (
    SELECT 1
    FROM "variant_changes" c
    JOIN "campaign_runs" r ON r."id" = c."runId"
    WHERE c."shopId" = e."shopId"
      AND c."variantGid" = e."variantGid"
      AND c."priceListGid" = e."priceListGid"
      AND c."status" IN ('VERIFIED', 'CLAMPED')
      AND r."kind" = 'REVERT'
      AND c."intendedPrice" = e."livePrice"
      AND NOT EXISTS (
        SELECT 1 FROM "variant_changes" n
        WHERE n."shopId" = c."shopId"
          AND n."variantGid" = c."variantGid"
          AND n."priceListGid" = c."priceListGid"
          AND n."status" IN ('VERIFIED', 'CLAMPED')
          AND n."verifiedAt" > c."verifiedAt"
      )
  )
`;

/** How many base prices across the store were changed outside any campaign. */
export async function staleBaselineCount(shopId: string): Promise<number> {
  return countCells(staleBaselineFrom(shopId, { baseOnly: true }));
}

/**
 * Of these off-baseline variants, how many no running campaign wrote (#745).
 *
 * For the previews, which already know each row's live price and baseline: they find the
 * rows off baseline themselves -- usually none -- and ask only about those. Asking the
 * database to recompute "off baseline" for a 70,000-variant scope meant joining it to its
 * baselines, and on freshly written rows the planner, expecting one, chose a nested loop
 * that took two minutes.
 */
export async function uncontrolledAmong(shopId: string, offBaselineVariantGids: readonly string[]): Promise<number> {
  if (offBaselineVariantGids.length === 0) return 0;

  const controlled = new Set<string>();
  for (let i = 0; i < offBaselineVariantGids.length; i += 5_000) {
    const rows = await prisma.variantChange.findMany({
      where: {
        shopId,
        variantGid: { in: offBaselineVariantGids.slice(i, i + 5_000) },
        priceListGid: "",
        status: { in: [...LANDED] },
        run: { campaign: { status: { in: [...PRICES_MAY_BE_LIVE] } } },
      },
      select: { variantGid: true },
      distinct: ["variantGid"],
    });
    for (const row of rows) controlled.add(row.variantGid);
  }

  // A price handed over by another campaign's revert is no running campaign's row, and was
  // not changed outside the app either (#1043). Asked only of the few left over.
  const rest = [...new Set(offBaselineVariantGids)].filter((gid) => !controlled.has(gid));
  for (let i = 0; i < rest.length; i += 5_000) {
    const rows = await prisma.$queryRaw<Array<{ variantGid: string }>>(Prisma.sql`
      SELECT e."variantGid" FROM "price_surface_entries" e
      WHERE e."shopId" = ${shopId} AND e."surfaceKind" = 'BASE' AND e."priceListGid" = ''
        AND e."variantGid" = ANY(${rest.slice(i, i + 5_000)})
        AND ${writtenByRevert}`);
    for (const row of rows) controlled.add(row.variantGid);
  }

  return new Set(offBaselineVariantGids).size - controlled.size;
}

/** The variants with a stale baseline on any surface, for a recapture scoped to them. */
export async function staleBaselineVariants(shopId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ variantGid: string }>>(
    Prisma.sql`SELECT DISTINCT e."variantGid" ${staleBaselineFrom(shopId)}`,
  );
  return rows.map((row) => row.variantGid);
}

/**
 * How many cells a `WHERE ... IN` may name.
 *
 * A bound on the filter, not on the truth. The count below deliberately does not use it.
 */
export const MAX_FILTER_CELLS = 5_000;

/** The statement listing matching cells, bounded so it can be named in a `WHERE ... IN`. */
export function cellsQuery(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`SELECT e."variantGid", e."priceListGid" ${where} LIMIT ${MAX_FILTER_CELLS}`;
}

async function cells(where: Prisma.Sql) {
  return prisma.$queryRaw<Array<{ variantGid: string; priceListGid: string }>>(cellsQuery(where));
}

/**
 * How many cells match, counted in the database.
 *
 * Not `cells(...).length`. That is what it used to be, and because `cells` is capped a
 * store with 8,000 drifted prices was told it had **5,000** -- a specific, plausible,
 * wrong number with nothing about it that reads as a ceiling. The cap belongs on the
 * filter, where naming 5,000 variants in a `WHERE ... IN` is a deliberate bound; on the
 * badge it silently replaced the answer.
 *
 * It also stops shipping up to 10,000 rows to Node so their length can be taken.
 */
export function countQuery(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`SELECT COUNT(*)::bigint AS count ${where}`;
}

async function countCells(where: Prisma.Sql): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(countQuery(where));
  return Number(row?.count ?? 0);
}

const driftedCells = (shopId: string) => cells(driftedFrom(shopId));
const offBaselineCells = (shopId: string) => cells(offBaselineFrom(shopId));
const staleBaselineCells = (shopId: string) => cells(staleBaselineFrom(shopId));

/**
 * Store-wide totals, not page totals.
 *
 * "12 products have drifted" is the number a merchant needs; "0 on this page" tells them
 * nothing and quietly implies everything is fine.
 */
async function counts(shopId: string) {
  const [drifted, offBaseline, staleBaseline] = await Promise.all([
    countCells(driftedFrom(shopId)),
    countCells(offBaselineFrom(shopId)),
    countCells(staleBaselineFrom(shopId)),
  ]);

  return { drifted, offBaseline, staleBaseline };
}

const key = (variantGid: string, priceListGid: string) => `${variantGid}@${priceListGid}`;

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}
