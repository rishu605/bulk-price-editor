/**
 * Targeting: turning a filter into a concrete set of variants.
 *
 * The filter AST is `(group OR group)` where each group is an AND of conditions.
 * Stored as JSON so segments stay versionable and previewable, and translated to a
 * Prisma `where` here rather than to raw SQL — the mirror's indexes (GIN on tags and
 * collections, btree on sku and price) do the work.
 */

import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { formatMinorUnits } from "../lib/money/format";
import { MAX_FACET_VALUES, type Facets } from "../lib/segments/facets";

export type ConditionField =
  | "collection"
  | "tag"
  /**
   * Everything the rest of the scope matches, *except* this tag.
   *
   * Sami has `Exclude products` as its own card beside "Apply to products", and neither
   * of the other two has anything — which is the difference between "everything on sale"
   * and "everything on sale except the four things we are not discounting". Every
   * merchant has the second list and until now had to express it by narrowing the first
   * one until it happened to leave them out.
   *
   * A condition rather than a separate field on the campaign, so preview, planning,
   * enrolment and the run path all handle it without knowing exclusions exist — the same
   * argument `variantGid` makes below. It also means an excluded variant is simply not in
   * this campaign's scope, so a lower-priority campaign covering it still wins, which is
   * what a merchant means by "leave this one out of the sale".
   */
  | "excludeTag"
  | "vendor"
  | "productType"
  | "status"
  | "title"
  | "sku"
  | "barcode"
  | "priceMin"
  | "priceMax"
  | "inventoryMin"
  | "inventoryMax"
  | "hasCompareAt"
  | "hasCost"
  /**
   * An explicit list of variants.
   *
   * What a frozen segment compiles to. Expressing it as an ordinary condition rather
   * than as a special case means preview, planning, enrollment and the run path all
   * handle a pinned variant list without knowing segments exist.
   */
  | "variantGid";

export interface Condition {
  field: ConditionField;
  /** A list only for `variantGid`, which is inherently plural. */
  value: string | number | boolean | string[];
}

/** AND of conditions. */
export interface ConditionGroup {
  conditions: Condition[];
}

/** OR of groups. An empty AST matches the whole catalogue. */
export interface FilterAst {
  groups: ConditionGroup[];
}

export const EMPTY_AST: FilterAst = { groups: [] };

function conditionToWhere(condition: Condition): Prisma.VariantIndexWhereInput | null {
  const { field, value } = condition;
  const text = String(value).trim();

  switch (field) {
    case "collection":
      return text ? { collections: { has: text } } : null;
    case "tag":
      return text ? { tags: { has: text } } : null;
    case "excludeTag":
      // `NOT` rather than a filter applied afterwards, so the exclusion is part of the
      // query the GIN index on `tags` serves rather than a second pass over the result.
      return text ? { NOT: { tags: { has: text } } } : null;
    case "vendor":
      return text ? { vendor: { equals: text, mode: "insensitive" } } : null;
    case "productType":
      return text ? { productType: { equals: text, mode: "insensitive" } } : null;
    case "status":
      return text ? { status: text.toUpperCase() as "ACTIVE" | "ARCHIVED" | "DRAFT" } : null;
    case "title":
      return text ? { title: { contains: text, mode: "insensitive" } } : null;
    case "sku":
      return text ? { sku: { contains: text, mode: "insensitive" } } : null;
    case "barcode":
      return text ? { barcode: { contains: text, mode: "insensitive" } } : null;
    case "priceMin":
      return { price: { gte: BigInt(Math.round(Number(value))) } };
    case "priceMax":
      return { price: { lte: BigInt(Math.round(Number(value))) } };
    case "inventoryMin":
      return { inventoryQty: { gte: Number(value) } };
    case "inventoryMax":
      return { inventoryQty: { lte: Number(value) } };
    case "hasCompareAt":
      return value ? { compareAt: { not: null } } : { compareAt: null };
    case "hasCost":
      return value ? { cost: { not: null } } : { cost: null };
    case "variantGid": {
      const gids = (Array.isArray(value) ? value : [text]).filter(Boolean);
      // An empty pinned list matches nothing, which is not the same as matching
      // everything. A frozen segment whose variants were all deleted must price zero
      // variants, not the entire catalogue.
      return { variantGid: { in: gids } };
    }
    default:
      return null;
  }
}

/**
 * Compiles an AST to a Prisma filter.
 *
 * Tombstoned variants are always excluded: a deleted variant must never be enrolled
 * in a campaign, but its ledger rows still have to resolve on revert (edge case E4).
 */
export function astToWhere(shopId: string, ast: FilterAst): Prisma.VariantIndexWhereInput {
  const base: Prisma.VariantIndexWhereInput = { shopId, deletedAt: null };

  const groups = (ast.groups ?? [])
    .map((group) => {
      const clauses = (group.conditions ?? [])
        .map(conditionToWhere)
        .filter((c): c is Prisma.VariantIndexWhereInput => c !== null);
      return clauses.length > 0 ? { AND: clauses } : null;
    })
    .filter((g): g is { AND: Prisma.VariantIndexWhereInput[] } => g !== null);

  if (groups.length === 0) return base;
  return { ...base, OR: groups };
}

export interface MatchPreview {
  count: number;
  sample: Array<{ variantGid: string; title: string; sku: string | null; price: string | null }>;
}

/** Live count plus a small sample, for the scope step of the wizard. */
export async function previewMatches(
  shopId: string,
  ast: FilterAst,
  sampleSize = 10,
): Promise<MatchPreview> {
  const where = astToWhere(shopId, ast);
  const [count, sample] = await Promise.all([
    prisma.variantIndex.count({ where }),
    prisma.variantIndex.findMany({
      where,
      take: sampleSize,
      orderBy: { title: "asc" },
      select: { variantGid: true, title: true, sku: true, price: true, currency: true },
    }),
  ]);

  return {
    count,
    sample: sample.map((v) => ({
      variantGid: v.variantGid,
      title: v.title ?? v.variantGid,
      sku: v.sku,
      price: formatMinorUnits(v.price, v.currency ?? "USD"),
    })),
  };
}

/** Every variant gid matching the AST, for enrollment. */
export async function resolveVariantGids(shopId: string, ast: FilterAst): Promise<string[]> {
  const rows = await prisma.variantIndex.findMany({
    where: astToWhere(shopId, ast),
    select: { variantGid: true },
  });
  return rows.map((r) => r.variantGid);
}

/**
 * The distinct values behind the scope picker's dropdowns.
 *
 * Distinct in the database, not in the app. This used to select `vendor`, `productType`,
 * `tags` and `collections` for every non-deleted variant and build four `Set`s from them:
 * 102,132 rows transferred and materialised to produce 53 values, on three route loaders,
 * for 330ms of every campaign editor's first paint. Only ~44ms of that was Postgres.
 *
 * The four run concurrently because they are four scans that share nothing; a `UNION`
 * over one scan reads better and plans as four anyway.
 *
 * **Sorted here rather than in SQL, deliberately.** `ORDER BY` uses the database's
 * collation, which differs between a Homebrew Postgres and Railway's — so the list would
 * be ordered one way locally and another in production. That is the shape of #278, where
 * `toLocaleString` rendered dates in the *server's* locale. It is not cosmetic either:
 * with a cap applied, a different order is a different hundred values. Sorting a few
 * thousand short strings in JS costs nothing and is the same everywhere.
 */
export async function facets(shopId: string): Promise<Facets> {
  const [vendors, productTypes, tags, collections] = await Promise.all([
    distinctScalar(shopId, "vendor"),
    distinctScalar(shopId, "productType"),
    distinctArray(shopId, "tags"),
    distinctArray(shopId, "collections"),
  ]);

  return {
    vendors: vendors.slice(0, MAX_FACET_VALUES),
    productTypes: productTypes.slice(0, MAX_FACET_VALUES),
    tags: tags.slice(0, MAX_FACET_VALUES),
    collections: collections.slice(0, MAX_FACET_VALUES),
    totals: {
      vendors: vendors.length,
      productTypes: productTypes.length,
      tags: tags.length,
      collections: collections.length,
    },
  };
}

/**
 * Every distinct non-empty value of one scalar column.
 *
 * `GROUP BY` rather than Prisma's `distinct`, which the client has historically applied
 * in memory for some connectors — the exact thing this function exists to stop doing.
 *
 * The column name is interpolated because it cannot be a bind parameter, so it is taken
 * from a union of two literals rather than from anything a caller composes.
 */
async function distinctScalar(shopId: string, column: "vendor" | "productType"): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
    `SELECT "${column}" AS value
       FROM "variant_index"
      WHERE "shopId" = $1 AND "deletedAt" IS NULL
        AND "${column}" IS NOT NULL AND "${column}" <> ''
      GROUP BY "${column}"`,
    shopId,
  );

  return rows.map((row) => row.value).sort();
}

/** The same for an array column, which needs `unnest` before it can be made distinct. */
async function distinctArray(shopId: string, column: "tags" | "collections"): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
    `SELECT DISTINCT unnest("${column}") AS value
       FROM "variant_index"
      WHERE "shopId" = $1 AND "deletedAt" IS NULL`,
    shopId,
  );

  return rows
    .map((row) => row.value)
    .filter(Boolean)
    .sort();
}

// ------------------------------------------------------------------ segments

/**
 * Compiles a segment to a filter.
 *
 * The dynamic/frozen distinction lives here and nowhere else. A dynamic segment is
 * its filter, re-evaluated every time it is asked; a frozen one is the list of
 * variants that filter matched when the merchant reviewed it. Both come out as an
 * AST, so everything downstream stays unaware of the difference.
 */
export function segmentToAst(segment: {
  kind: "DYNAMIC" | "FROZEN";
  filterAst: unknown;
  frozenVariantGids: string[];
}): FilterAst {
  if (segment.kind === "FROZEN") {
    return { groups: [{ conditions: [{ field: "variantGid", value: segment.frozenVariantGids }] }] };
  }
  return ((segment.filterAst as FilterAst) ?? EMPTY_AST).groups
    ? (segment.filterAst as FilterAst)
    : EMPTY_AST;
}
