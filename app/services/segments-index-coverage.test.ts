/**
 * Every case-insensitive scope condition has an index Postgres can actually use.
 *
 * `mode: "insensitive"` compiles to `ILIKE`, and *no btree serves ILIKE* — not even one
 * on `lower(col)`. The original data model created exactly that pair for `title` and
 * `sku`, described them in a comment as "case-insensitive prefix search", and they
 * recorded zero scans for the eighteen days they existed on a 102,132-variant store.
 * The comment was not wrong about btrees: `lower(sku) LIKE 'abc%'` would have used it.
 * The code simply never issued that query, and nothing connected the two halves.
 *
 * That is the failure this file exists to prevent, and the reason it checks the *class*
 * rather than the two columns that were wrong. Adding a condition is one line in
 * `conditionToWhere`; noticing that the line commits the mirror to a sequential scan of
 * every merchant's catalogue is not something the diff shows.
 *
 * Two properties keep it honest as the engine grows:
 *
 *   The field list is a `Record<ConditionField, …>`, so adding a member to the union
 *   fails the *typecheck* until it is classified here. An enumeration that can silently
 *   fall behind the thing it enumerates is the same bug in a different place.
 *
 *   The indexed columns are read out of `schema.prisma` rather than restated, so this
 *   cannot agree with a list that no longer matches the database.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";
import { astToWhere, type Condition, type ConditionField } from "./segments.server";

/**
 * Columns on `variant_index` carrying a trigram GIN index, from the schema itself.
 *
 * Scoped to the model block: `@@index` lines elsewhere in the file describe other
 * tables, and a trigram index on some unrelated model must not satisfy a scan here.
 *
 * Read through `sourceOf`, so the doc comment above those very `@@index` lines — which
 * explains what a trigram index is for, in the same words — cannot be what satisfies
 * this. That is the repo's oldest recurring trap and it applies to a schema as readily
 * as to a route.
 */
function trigramIndexedColumns(): Set<string> {
  const schema = sourceOf("prisma", "schema.prisma");

  const model = /model VariantIndex \{([\s\S]*?)\n\}/.exec(schema);
  if (!model) throw new Error("VariantIndex model not found in schema.prisma");

  return new Set(
    [...model[1].matchAll(/@@index\(\[(\w+)\(ops: raw\("gin_trgm_ops"\)\)\]/g)].map(
      (match) => match[1],
    ),
  );
}

/**
 * The columns a Prisma filter matches case-insensitively.
 *
 * Walks the object the filter engine produced rather than the source that produced it.
 * A grep for `mode: "insensitive"` would pass the day somebody extracts a helper, and
 * would say nothing about what the query actually asks for.
 */
function insensitiveColumns(where: unknown, column: string | null = null): string[] {
  if (!where || typeof where !== "object") return [];

  const entries = Object.entries(where as Record<string, unknown>);

  if (entries.some(([key, value]) => key === "mode" && value === "insensitive")) {
    return column ? [column] : [];
  }

  return entries.flatMap(([key, value]) =>
    Array.isArray(value)
      ? value.flatMap((item) => insensitiveColumns(item, key))
      : // AND/OR/NOT are combinators, not columns — keep whatever column we are inside
        // so a condition nested under `NOT` is still attributed to its own column.
        insensitiveColumns(value, key === "AND" || key === "OR" || key === "NOT" ? column : key),
  );
}

/**
 * A value each field will accept, so `conditionToWhere` returns a clause rather than the
 * null it uses for "nothing to filter on".
 */
const SAMPLE: Record<ConditionField, Condition["value"]> = {
  collection: "summer",
  tag: "sale",
  excludeTag: "clearance",
  vendor: "Northwind",
  productType: "Boots",
  status: "active",
  title: "Alpine",
  sku: "APF-927",
  barcode: "0123456789012",
  priceMin: 1000,
  priceMax: 9000,
  inventoryMin: 1,
  inventoryMax: 100,
  hasCompareAt: true,
  hasCost: true,
  variantGid: ["gid://shopify/ProductVariant/1"],
};

/**
 * Columns matched case-insensitively that are deliberately left to a sequential scan.
 *
 * Both are low-cardinality equality. "Northwind" matches 11% of anchor-perf's catalogue,
 * and reading 11% of a heap costs what it costs however the rows are reached — measured
 * at 28.5ms scanning against 25.9ms through a trigram index, which does not pay for a
 * GIN index maintained on every one of ~102K sync upserts.
 *
 * The entry is the point: an accepted scan is a decision with a number behind it, and
 * anything not listed here has to earn its index or be added with a reason.
 */
const ACCEPTED_SCANS = new Set(["vendor", "productType"]);

const FIELDS = Object.keys(SAMPLE) as ConditionField[];

describe("case-insensitive conditions", () => {
  const indexed = trigramIndexedColumns();

  it.each(FIELDS)("%s matches through an index, or is an accepted scan", (field) => {
    const where = astToWhere("shop_1", {
      groups: [{ conditions: [{ field, value: SAMPLE[field] }] }],
    });

    for (const column of insensitiveColumns(where)) {
      expect(
        indexed.has(column) || ACCEPTED_SCANS.has(column),
        `\`${field}\` matches \`${column}\` with mode: "insensitive", which Prisma ` +
          `compiles to ILIKE. No btree serves ILIKE, so this reads every variant the ` +
          `shop has. Add a trigram GIN index on \`${column}\` in schema.prisma and a ` +
          `migration, or add it to ACCEPTED_SCANS with the measurement that justifies it.`,
      ).toBe(true);
    }
  });

  it("finds the insensitive matches at all", () => {
    // Guards the guard. If `insensitiveColumns` ever returned nothing — a Prisma
    // upgrade renaming the key, a walk that stops one level too early — every
    // assertion above would pass vacuously and this file would protect nothing.
    const found = FIELDS.flatMap((field) =>
      insensitiveColumns(
        astToWhere("shop_1", { groups: [{ conditions: [{ field, value: SAMPLE[field] }] }] }),
      ),
    );

    expect(new Set(found)).toEqual(new Set(["vendor", "productType", "title", "sku", "barcode"]));
  });

  it("reads real index declarations out of the schema", () => {
    // Guards the other half: an empty set would make `indexed.has` always false, which
    // fails loudly, but a regex matching the wrong thing could just as easily return a
    // set that happens to contain the names.
    expect(trigramIndexedColumns()).toEqual(new Set(["title", "sku", "barcode"]));
  });
});

describe("attributing a match to its column", () => {
  it("looks through the NOT that excludeTag wraps its condition in", () => {
    expect(insensitiveColumns({ NOT: { vendor: { contains: "x", mode: "insensitive" } } })).toEqual(
      ["vendor"],
    );
  });

  it("looks through the OR of groups an AST compiles to", () => {
    const columns = insensitiveColumns({
      OR: [
        { AND: [{ title: { contains: "a", mode: "insensitive" } }] },
        { AND: [{ sku: { contains: "b", mode: "insensitive" } }] },
      ],
    });

    expect(new Set(columns)).toEqual(new Set(["title", "sku"]));
  });

  it("says nothing about a case-sensitive match", () => {
    expect(insensitiveColumns({ status: "ACTIVE", price: { gte: 100n } })).toEqual([]);
  });
});
