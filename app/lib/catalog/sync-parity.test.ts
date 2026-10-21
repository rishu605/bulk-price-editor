/**
 * Both sync paths write the same columns.
 *
 * A store below the row threshold syncs page by page; above it, one bulk operation.
 * Which path runs is decided by catalogue size and nothing else, so a column written by
 * one and not the other means the app behaves differently on large stores — silently,
 * and only on the stores it exists for.
 *
 * That is not hypothetical. The bulk path once wrote `variant_index` and never
 * `price_surface_entries`, so every bulk-imported variant was mirrored, counted, listed
 * and impossible to price. Ninety-four chaos scenarios and seven hundred unit tests
 * missed it because every assertion counted `variant_index` rows, and the dashboard's
 * only suggested fix — re-sync — ran the same broken path again.
 *
 * Adding `imageUrl` reproduced the first half of exactly that: the query fetched it, the
 * parser carried it, and the bulk writer dropped it on the floor.
 *
 * So this compares the two paths field by field, from the source. It cannot prove the
 * values agree — only a real sync does that — but it does prove neither path has a
 * column the other has never heard of.
 *
 * Since #1087 both write through one writer, `writeCatalogRows`, which keeps a row the
 * mirror holds a newer version of. So the comparison is of what each path reads into a row
 * against what that writer puts in the mirror, and that neither path writes around it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const paginated = readFileSync(
  join(process.cwd(), "app", "services", "catalog-sync.server.ts"),
  "utf8",
);
const bulk = readFileSync(
  join(process.cwd(), "app", "services", "catalog-bulk-sync.server.ts"),
  "utf8",
);
const writer = readFileSync(
  join(process.cwd(), "app", "services", "catalog-write.server.ts"),
  "utf8",
);

/** Column names assigned in a `variantIndex` write, taken from the source. */
function columnsWritten(source: string): Set<string> {
  const written = new Set<string>();

  // `name: value,` and the shorthand `name,`. Missing the shorthand form is not
  // academic — the paginated path writes `collections,` that way, so a check that only
  // understood the long form reported the wrong path as the broken one.
  for (const match of source.matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9]*)(?::\s|,$)/gm)) {
    written.add(match[1]);
  }
  return written;
}

/** The columns that describe a variant. Bookkeeping is allowed to differ. */
const CATALOGUE_COLUMNS = [
  "productGid",
  "title",
  "sku",
  "barcode",
  "price",
  "compareAt",
  "cost",
  "currency",
  "inventoryQty",
  "status",
  "vendor",
  "productType",
  "tags",
  "collections",
  "imageUrl",
  "remoteUpdatedAt",
  "isGiftCard",
];

/**
 * The writer creates a variant it has never seen and rewrites one it has, so it has two
 * independent field lists. Checking the file as a whole passes when a column is dropped
 * from one of them — and a column present on create but missing on update means a variant
 * is right until the next sync touches it, which is worse than being wrong from the start
 * because it looks like it worked.
 */
function writerBranches(source: string): { create: Set<string>; update: Set<string> } {
  const createStart = source.indexOf("prisma.variantIndex.createMany(");
  const create = createStart < 0 ? new Set<string>() : columnsWritten(source.slice(createStart, source.indexOf("skipDuplicates", createStart)));
  const updateStart = source.indexOf("written AS (");
  const update =
    updateStart < 0
      ? new Set<string>()
      : new Set([...source.slice(updateStart, source.indexOf("RETURNING", updateStart)).matchAll(/"(\w+)" = i\./g)].map((match) => match[1]));
  return { create, update };
}

describe("the bulk path writes everything the paginated path does", () => {
  const inPaginated = columnsWritten(paginated);
  const branches = writerBranches(writer);

  it("found both halves of the writer to compare", () => {
    expect(branches.create.size).toBeGreaterThan(8);
    expect(branches.update.size).toBeGreaterThan(8);
  });

  it("writes both paths through the one writer, and neither around it (#1087)", () => {
    for (const [path, source] of [["paginated", paginated], ["bulk", bulk]] as const) {
      expect(source, `the ${path} path does not write through writeCatalogRows`).toContain("writeCatalogRows(");
      expect(source, `the ${path} path writes the mirror around the writer, unguarded`).not.toMatch(
        /(variantIndex|priceSurfaceEntry)\.(upsert|update|updateMany|create|createMany)\(/,
      );
    }
  });

  it.each(CATALOGUE_COLUMNS)("both paths write %s", (column) => {
    expect(inPaginated.has(column), `the paginated path never reads ${column} into a row`).toBe(true);
    expect(
      branches.create.has(column),
      `the catalogue writer does not write ${column} when it first sees a variant — so a ` +
        `store gets it empty until something else fills it`,
    ).toBe(true);
    expect(
      branches.update.has(column),
      `the catalogue writer does not write ${column} when it re-syncs a variant — so it is ` +
        `right once and wrong from the second sync onwards, which looks like it worked`,
    ).toBe(true);
  });

  it("asks Shopify for isGiftCard on both paths, not just one", () => {
    // The column that stops gift cards being repriced is worth nothing if the query
    // never asks for it -- which is precisely how they came to be repriced. The writer
    // would happily persist `false` forever and every parity check above would pass.
    expect(paginated, "the paginated query does not select isGiftCard").toContain(
      "isGiftCard",
    );
    expect(
      sourceOf(process.cwd(), "app", "lib", "catalog", "bulk-jsonl.ts"),
      "CATALOG_BULK_QUERY does not select isGiftCard",
    ).toContain("isGiftCard");
  });

  it("fetches the image on both paths, not just one", () => {
    // Writing a column the query never asked for is the same bug wearing a different hat.
    expect(paginated).toContain("featuredImage { url }");
    expect(paginated).toContain("image { url }");
    expect(
      sourceOf(process.cwd(), "app", "lib", "catalog", "bulk-jsonl.ts"),
    ).toContain("featuredImage { url }");
  });

  it("asks for the same variant fields on every page of the paginated path as the bulk query does (#738)", () => {
    // The follow-up page for a product's 101st variant onwards left out `image { url }`, so
    // those variants lost their own image whenever this path ran.
    const fieldsOf = (selection: string) =>
      selection
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("pageInfo") && line !== "}")
        .sort();
    const variantNodes = (source: string) =>
      [...source.matchAll(/variants\([^)]*\) \{[\s\S]*?nodes \{([\s\S]*?)\n\s*\}\n\s*\}/g)].map((match) => fieldsOf(match[1]));
    const pages = variantNodes(paginated);
    expect(pages, "found the page's and the follow-up's variant selections").toHaveLength(2);
    const bulkQuery = sourceOf(process.cwd(), "app", "lib", "catalog", "bulk-jsonl.ts");
    const bulkFields = fieldsOf(/variants \{\s*edges \{\s*node \{([\s\S]*?)\n\s*\}\n\s*\}/.exec(bulkQuery)![1]);
    expect(pages[0], "the page asks for different variant fields than the bulk query").toEqual(bulkFields);
    expect(pages[1], "the follow-up page asks for different variant fields than the first").toEqual(bulkFields);
  });

  it("pages a product's collections past the first page, as the bulk query gets them all (#738)", () => {
    expect(paginated).toMatch(/collections\(first: \d+\) \{\s*pageInfo \{ hasNextPage endCursor \}/);
    expect(paginated).toContain("collections(first: 250, after: $cursor)");
  });
});

