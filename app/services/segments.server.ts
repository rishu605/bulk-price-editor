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

export type ConditionField =
  | "collection"
  | "tag"
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
  | "hasCost";

export interface Condition {
  field: ConditionField;
  value: string | number | boolean;
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

/** Distinct values available for the picker, so the UI offers real options. */
export async function facets(shopId: string): Promise<{
  vendors: string[];
  productTypes: string[];
  tags: string[];
  collections: string[];
}> {
  const rows = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null },
    select: { vendor: true, productType: true, tags: true, collections: true },
  });

  const vendors = new Set<string>();
  const productTypes = new Set<string>();
  const tags = new Set<string>();
  const collections = new Set<string>();

  for (const row of rows) {
    if (row.vendor) vendors.add(row.vendor);
    if (row.productType) productTypes.add(row.productType);
    for (const tag of row.tags) tags.add(tag);
    for (const collection of row.collections) collections.add(collection);
  }

  const sorted = (set: Set<string>) => [...set].sort().slice(0, 100);
  return {
    vendors: sorted(vendors),
    productTypes: sorted(productTypes),
    tags: sorted(tags),
    collections: sorted(collections),
  };
}
