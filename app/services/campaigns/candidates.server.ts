/**
 * Loading the inputs the planner needs: baselines plus mirrored live values.
 *
 * Three bulk queries rather than per-variant lookups. On a 1,600-variant catalogue
 * the per-variant version meant thousands of round trips, which is what made an
 * earlier version of baseline capture appear to hang.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { money, type Money } from "../../lib/money/money";
import type { Baseline } from "../../lib/pricing/types";
import { inVariantOrder } from "../../lib/planning/candidate-order";
import type { PlanCandidate } from "../../lib/planning/types";
import { astToWhere, type FilterAst } from "../segments.server";

/** Variant gid -> product gid, needed because the write mutation is per product. */
export async function productMapFor(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, string>> {
  if (variantGids.length === 0) return new Map();

  const rows = await inChunks(variantGids, (batch) =>
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: batch } },
      select: { variantGid: true, productGid: true },
    }),
  );

  return new Map(rows.map((row) => [row.variantGid, row.productGid]));
}

/**
 * Variant gid -> what a merchant needs to recognise the row: its title and its picture.
 *
 * A price table is a wall of near-identical strings — "Alpine Boots 1020 · Black / L /
 * E0" differs from its neighbour by two characters. The thumbnail is how someone
 * notices that a rule caught something it should not have, which is the whole reason a
 * preview exists.
 */
export async function variantDisplayFor(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, { title: string; imageUrl: string | null }>> {
  if (variantGids.length === 0) return new Map();

  const rows = await inChunks(variantGids, (batch) =>
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: batch } },
      select: { variantGid: true, title: true, imageUrl: true },
    }),
  );

  return new Map(
    rows.map((row) => [
      row.variantGid,
      { title: row.title ?? row.variantGid, imageUrl: row.imageUrl },
    ]),
  );
}

/** Variant gid -> display title, for previews and ledgers. */
export async function titleMapFor(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, string>> {
  if (variantGids.length === 0) return new Map();

  const rows = await inChunks(variantGids, (batch) =>
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: batch } },
      select: { variantGid: true, title: true },
    }),
  );

  return new Map(rows.map((row) => [row.variantGid, row.title ?? row.variantGid]));
}

/**
 * Builds the planner's candidate list for a campaign's scope.
 *
 * Variants with no current baseline are omitted entirely. That is deliberate: with
 * nothing to compute from, the only alternative is pricing off the live value, which
 * is exactly the compounding bug this product exists to prevent. The dashboard
 * surfaces the count separately so the gap is visible rather than silent.
 */
export async function loadCandidates(
  shopId: string,
  ast: FilterAst,
  /**
   * Restricts the scope to these variants, for a run that concerns only some of them.
   *
   * Intersected with the campaign's filter rather than replacing it: a variant outside
   * the campaign's scope must not be pulled into a run just because a caller named it.
   */
  onlyVariantGids?: string[],
  /**
   * Imports whose prices these candidates may need.
   *
   * Passed in rather than discovered, because only the caller knows which campaigns are
   * in play — and loading every import a shop has ever done would be a table scan for
   * the many campaigns that use none.
   */
  importIds: readonly string[] = [],
): Promise<PlanCandidate[]> {
  if (onlyVariantGids?.length === 0) return [];

  const scope = astToWhere(shopId, ast);
  const select = { variantGid: true, currency: true, cost: true, title: true } as const;
  // In one fixed order (#769), because the planner keeps the order it is given and every
  // preview lists its rows in it. The full preview re-plans for each page and shows that
  // page's slice, so an order that changed between two loads -- as Postgres's did whenever
  // a sync rewrote a row -- showed some variants twice and others never. Sorted here, once,
  // so the editor's panel, the full preview, the campaign page and the run all agree.
  const variants = inVariantOrder(
    onlyVariantGids
      ? await inChunks(onlyVariantGids, (batch) =>
          prisma.variantIndex.findMany({ where: { ...scope, variantGid: { in: batch } }, select }),
        )
      : await prisma.variantIndex.findMany({ where: scope, select }),
  );
  if (variants.length === 0) return [];

  const gids = variants.map((v) => v.variantGid);

  const imported = await importedPricesByVariant(importIds, gids);

  const { baselines, entries } = await baseRowsOf(shopId, gids);

  const baselineBy = new Map(baselines.map((b) => [b.variantGid, b]));
  const entryBy = new Map(entries.map((e) => [e.variantGid, e]));

  const candidates: PlanCandidate[] = [];

  for (const variant of variants) {
    const baseline = baselineBy.get(variant.variantGid);
    if (!baseline) continue;

    // The surface's currency is the variant's; the baseline keeps its own. They used to be
    // one value taken from the baseline first, so a baseline recorded in another currency
    // relabelled the surface to match and the planner's currency backstop never fired:
    // a JPY 2,500 baseline was discounted and written to a USD price as $2,000 (#734). Kept
    // apart, such a row resolves in the baseline's currency, which is not the surface's,
    // and the planner leaves it alone, visibly.
    const currency = variant.currency || baseline.currency || "USD";
    const baselineCurrency = baseline.currency || currency;
    const entry = entryBy.get(variant.variantGid);

    const asMoney = (value: bigint | null | undefined): Money | undefined =>
      value === null || value === undefined ? undefined : money(Number(value), currency);
    const inBaselineCurrency = (value: bigint | null | undefined): Money | undefined =>
      value === null || value === undefined ? undefined : money(Number(value), baselineCurrency);

    const base: Baseline = {
      price: money(Number(baseline.basePrice), baselineCurrency),
      compareAtPrice: inBaselineCurrency(baseline.baseCompareAt),
      // Costs are recorded in the store's currency, which is the surface's.
      cost: asMoney(baseline.cost ?? variant.cost),
    };

    candidates.push({
      ref: { variantGid: variant.variantGid, surfaceKind: "base", priceListGid: "", currency },
      baseline: base,
      livePrice: asMoney(entry?.livePrice),
      liveCompareAt: asMoney(entry?.liveCompareAt),
      ...(imported.size > 0 ? pricesFor(imported, variant.variantGid, currency) : {}),
    });
  }

  return candidates;
}

/** What a candidate reads from a variant's current base baseline. */
interface BaselineRow {
  variantGid: string;
  currency: string;
  basePrice: bigint;
  baseCompareAt: bigint | null;
  cost: bigint | null;
}

/** What a candidate reads from a variant's base surface entry. */
interface EntryRow {
  variantGid: string;
  livePrice: bigint | null;
  liveCompareAt: bigint | null;
}

/**
 * The current base baselines and base live prices of these variants, in two reads however
 * many there are (#524).
 *
 * They were read 5,000 ids at a time, and Postgres answered each batch by reading every row
 * the shop has: one pass over its `baselines` and one over its `price_surface_entries` per
 * 5,000 variants in scope, so the work grew with the scope times the shop. A 102,132-variant
 * plan was 42 full scans. Here the ids go as one array, which is one bind variable at any
 * length, so the ceiling `chunk.ts` guards cannot be reached and each table is read once.
 *
 * The scope's ids rather than its filter, which is what a join to `variant_index` would need.
 * Putting the filter in this SQL means a second translation of it beside `astToWhere`, and two
 * translations of one scope are how a preview comes to disagree with its run (rule 4). A
 * relation Prisma could filter through needs a foreign key, which fails on a baseline for a
 * variant the mirror does not have (#252). These ids are the rows the scope query returned, so
 * they cannot name any other variants.
 *
 * `force_custom_plan`, because Prisma keeps each statement prepared on its connection, and
 * from a prepared statement's sixth execution Postgres may plan it once without its values.
 * Blind to the array's length, that plan probes the index once per id. On 102,273 ids the two
 * reads took 280ms for five plans and 3,400ms from the sixth, more than three times as long
 * as the chunks they replace. Planned with the values every time, a wide scope is one hashed
 * pass over each table and a narrow one a probe per id. `SET LOCAL` ends with this
 * transaction, so nothing else on the pooled connection is planned differently, and behind
 * PgBouncer, where Prisma prepares nothing, it changes nothing.
 *
 * The same conditions the chunked reads had, so the same rows: `loadCandidates` walks the
 * scope's variants and only looks these up. `candidate-reads.chaos.ts` holds them to the
 * chunked reads over random catalogues and scopes.
 */
async function baseRowsOf(
  shopId: string,
  gids: string[],
): Promise<{ baselines: BaselineRow[]; entries: EntryRow[] }> {
  const [, baselines, entries] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`,
    prisma.$queryRaw<BaselineRow[]>`
      SELECT b."variantGid", b."currency", b."basePrice", b."baseCompareAt", b."cost"
      FROM "baselines" b
      WHERE b."shopId" = ${shopId} AND b."supersededAt" IS NULL AND b."surfaceKind" = 'BASE'
        AND b."variantGid" = ANY(${gids}::text[])`,
    prisma.$queryRaw<EntryRow[]>`
      SELECT e."variantGid", e."livePrice", e."liveCompareAt"
      FROM "price_surface_entries" e
      WHERE e."shopId" = ${shopId} AND e."surfaceKind" = 'BASE'
        AND e."variantGid" = ANY(${gids}::text[])`,
  ]);
  return { baselines, entries };
}

/**
 * The variants whose base price this campaign has written since it last finished
 * reverting: what a whole-campaign revert has to take back (#828). Deleted variants are
 * left out -- there is nothing on the storefront to revert.
 */
export async function pricesWrittenBy(shopId: string, campaignId: string): Promise<string[]> {
  const lastRevert = await prisma.campaignRun.findFirst({
    where: { campaignId, kind: "REVERT", status: "COMPLETED", NOT: { occurrenceKey: { startsWith: "VARIANT-" } } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const rows = await prisma.$queryRaw<Array<{ variantGid: string }>>`
    SELECT DISTINCT c."variantGid"
    FROM "variant_changes" c
    JOIN "campaign_runs" r ON r."id" = c."runId"
    JOIN "variant_index" v ON v."shopId" = c."shopId" AND v."variantGid" = c."variantGid"
    WHERE r."campaignId" = ${campaignId} AND r."kind" = 'APPLY'
      AND c."shopId" = ${shopId} AND c."surfaceKind" = 'BASE' AND c."priceListGid" = ''
      AND c."status" IN ('VERIFIED', 'CLAMPED')
      AND v."deletedAt" IS NULL
      ${lastRevert ? Prisma.sql`AND r."createdAt" > (${lastRevert.createdAt}::timestamptz AT TIME ZONE 'UTC')` : Prisma.empty}`;
  return rows.map((row) => row.variantGid);
}

/**
 * A whole-campaign revert's candidates: its scope's, and every variant it wrote that has
 * since left that scope.
 *
 * What a campaign wrote is what its revert takes back, whatever the scope says now (#828,
 * edge case E6) -- a product untagged mid-sale keeps the sale price otherwise. Since #751
 * a scope also follows product status, so the ordinary case is a product archived or set
 * back to draft mid-sale. One function for the revert and both of its previews (the
 * confirmation's and the rollback report's): each used to plan from the scope alone, and
 * said such a product "reverts to" its sale price while the revert put its baseline back.
 *
 * Loaded with no conditions and no status, so nothing about the scope can drop them again.
 */
export async function withWritten(
  shopId: string,
  scoped: PlanCandidate[],
  written: readonly string[],
  importIds: readonly string[],
): Promise<PlanCandidate[]> {
  const inScope = new Set(scoped.map((candidate) => candidate.ref.variantGid));
  const strays = written.filter((gid) => !inScope.has(gid));
  if (strays.length === 0) return scoped;
  return [...scoped, ...(await loadCandidates(shopId, { groups: [] }, strays, importIds))];
}

/** One variant's row in one import: its price, and its compare-at where the row gave one. */
interface ImportedRow {
  price: bigint;
  compareAt: bigint | null;
}

/**
 * Imported prices for these variants, from these imports.
 *
 * Keyed variant → import → row, because a variant can appear in more than one import
 * and the rule names which one it means. Two campaigns from two files pricing the same
 * product is exactly the overlap the resolver exists to settle, and it can only do that
 * if both prices are available to it.
 *
 * The compare-at as well (#766). It was stored with every row and selected by nothing, so
 * a file's compare-at column was checked, kept, and never written.
 */
async function importedPricesByVariant(
  importIds: readonly string[],
  variantGids: readonly string[],
): Promise<Map<string, Map<string, ImportedRow>>> {
  if (importIds.length === 0 || variantGids.length === 0) return new Map();

  const rows = await inChunks([...variantGids], (batch) =>
    prisma.priceImportRow.findMany({
      where: { importId: { in: [...importIds] }, variantGid: { in: batch } },
      select: { importId: true, variantGid: true, price: true, compareAt: true },
    }),
  );

  const byVariant = new Map<string, Map<string, ImportedRow>>();
  for (const row of rows) {
    const forVariant = byVariant.get(row.variantGid) ?? new Map<string, ImportedRow>();
    forVariant.set(row.importId, { price: row.price, compareAt: row.compareAt });
    byVariant.set(row.variantGid, forVariant);
  }

  return byVariant;
}

/** A variant's imported prices and compare-ats, by import id, in the surface's currency. */
function pricesFor(
  imported: Map<string, Map<string, ImportedRow>>,
  variantGid: string,
  currency: string,
): Pick<PlanCandidate, "importedPrices" | "importedCompareAts"> {
  const forVariant = [...(imported.get(variantGid) ?? [])];

  return {
    importedPrices: Object.fromEntries(
      forVariant.map(([importId, row]) => [importId, money(Number(row.price), currency)]),
    ),
    importedCompareAts: Object.fromEntries(
      forVariant
        .filter(([, row]) => row.compareAt !== null)
        .map(([importId, row]) => [importId, money(Number(row.compareAt), currency)]),
    ),
  };
}
