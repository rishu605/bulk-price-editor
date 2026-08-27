/**
 * Loading the inputs the planner needs: baselines plus mirrored live values.
 *
 * Three bulk queries rather than per-variant lookups. On a 1,600-variant catalogue
 * the per-variant version meant thousands of round trips, which is what made an
 * earlier version of baseline capture appear to hang.
 */

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { money, type Money } from "../../lib/money/money";
import type { Baseline } from "../../lib/pricing/types";
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
  const variants = onlyVariantGids
    ? await inChunks(onlyVariantGids, (batch) =>
        prisma.variantIndex.findMany({
          where: { ...scope, variantGid: { in: batch } },
          select: { variantGid: true, currency: true, cost: true },
        }),
      )
    : await prisma.variantIndex.findMany({
        where: scope,
        select: { variantGid: true, currency: true, cost: true },
      });
  if (variants.length === 0) return [];

  const gids = variants.map((v) => v.variantGid);

  const imported = await importedPricesByVariant(importIds, gids);

  const [baselines, entries] = await Promise.all([
    inChunks(gids, (batch) =>
      prisma.baseline.findMany({
        where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: batch } },
      }),
    ),
    inChunks(gids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: { shopId, surfaceKind: "BASE", variantGid: { in: batch } },
      }),
    ),
  ]);

  const baselineBy = new Map(baselines.map((b) => [b.variantGid, b]));
  const entryBy = new Map(entries.map((e) => [e.variantGid, e]));

  const candidates: PlanCandidate[] = [];

  for (const variant of variants) {
    const baseline = baselineBy.get(variant.variantGid);
    if (!baseline) continue;

    const currency = baseline.currency || variant.currency || "USD";
    const entry = entryBy.get(variant.variantGid);

    const asMoney = (value: bigint | null | undefined): Money | undefined =>
      value === null || value === undefined ? undefined : money(Number(value), currency);

    const base: Baseline = {
      price: money(Number(baseline.basePrice), currency),
      compareAtPrice: asMoney(baseline.baseCompareAt),
      cost: asMoney(baseline.cost ?? variant.cost),
    };

    candidates.push({
      ref: { variantGid: variant.variantGid, surfaceKind: "base", priceListGid: "", currency },
      baseline: base,
      livePrice: asMoney(entry?.livePrice),
      liveCompareAt: asMoney(entry?.liveCompareAt),
      ...(imported.size > 0
        ? { importedPrices: pricesFor(imported, variant.variantGid, currency) }
        : {}),
    });
  }

  return candidates;
}


/**
 * Imported prices for these variants, from these imports.
 *
 * Keyed variant → import → price, because a variant can appear in more than one import
 * and the rule names which one it means. Two campaigns from two files pricing the same
 * product is exactly the overlap the resolver exists to settle, and it can only do that
 * if both prices are available to it.
 */
async function importedPricesByVariant(
  importIds: readonly string[],
  variantGids: readonly string[],
): Promise<Map<string, Map<string, bigint>>> {
  if (importIds.length === 0 || variantGids.length === 0) return new Map();

  const rows = await inChunks([...variantGids], (batch) =>
    prisma.priceImportRow.findMany({
      where: { importId: { in: [...importIds] }, variantGid: { in: batch } },
      select: { importId: true, variantGid: true, price: true },
    }),
  );

  const byVariant = new Map<string, Map<string, bigint>>();
  for (const row of rows) {
    const forVariant = byVariant.get(row.variantGid) ?? new Map<string, bigint>();
    forVariant.set(row.importId, row.price);
    byVariant.set(row.variantGid, forVariant);
  }

  return byVariant;
}

function pricesFor(
  imported: Map<string, Map<string, bigint>>,
  variantGid: string,
  currency: string,
): Record<string, Money> {
  const forVariant = imported.get(variantGid);
  if (!forVariant) return {};

  return Object.fromEntries(
    [...forVariant].map(([importId, price]) => [importId, money(Number(price), currency)]),
  );
}
