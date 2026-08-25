/**
 * Loading the inputs the planner needs: baselines plus mirrored live values.
 *
 * Three bulk queries rather than per-variant lookups. On a 1,600-variant catalogue
 * the per-variant version meant thousands of round trips, which is what made an
 * earlier version of baseline capture appear to hang.
 */

import prisma from "../../db.server";
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

  const rows = await prisma.variantIndex.findMany({
    where: { shopId, variantGid: { in: variantGids } },
    select: { variantGid: true, productGid: true },
  });

  return new Map(rows.map((row) => [row.variantGid, row.productGid]));
}

/** Variant gid -> display title, for previews and ledgers. */
export async function titleMapFor(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, string>> {
  if (variantGids.length === 0) return new Map();

  const rows = await prisma.variantIndex.findMany({
    where: { shopId, variantGid: { in: variantGids } },
    select: { variantGid: true, title: true },
  });

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
): Promise<PlanCandidate[]> {
  if (onlyVariantGids?.length === 0) return [];

  const variants = await prisma.variantIndex.findMany({
    where: {
      ...astToWhere(shopId, ast),
      ...(onlyVariantGids ? { variantGid: { in: onlyVariantGids } } : {}),
    },
    select: { variantGid: true, currency: true, cost: true },
  });
  if (variants.length === 0) return [];

  const gids = variants.map((v) => v.variantGid);

  const [baselines, entries] = await Promise.all([
    prisma.baseline.findMany({
      where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: gids } },
    }),
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, surfaceKind: "BASE", variantGid: { in: gids } },
    }),
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
    });
  }

  return candidates;
}
