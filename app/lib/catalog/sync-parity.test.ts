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
 * So this compares the two writers field by field, from the source. It cannot prove the
 * values agree — only a real sync does that — but it does prove neither path has a
 * column the other has never heard of.
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
];

/**
 * The bulk writer is an upsert, so it has two independent field lists. Checking the file
 * as a whole passes when a column is dropped from one of them — and a column present on
 * create but missing on update means a variant is right until the next sync touches it,
 * which is worse than being wrong from the start because it looks like it worked.
 */
function upsertBranches(source: string): { create: Set<string>; update: Set<string> } {
  const slice = (key: "create" | "update") => {
    const start = source.indexOf(`        ${key}: {`);
    if (start < 0) return new Set<string>();
    return columnsWritten(source.slice(start, source.indexOf("\n        },", start)));
  };
  return { create: slice("create"), update: slice("update") };
}

describe("the bulk path writes everything the paginated path does", () => {
  const inPaginated = columnsWritten(paginated);
  const branches = upsertBranches(bulk);

  it("found both halves of the upsert to compare", () => {
    expect(branches.create.size).toBeGreaterThan(8);
    expect(branches.update.size).toBeGreaterThan(8);
  });

  it.each(CATALOGUE_COLUMNS)("both paths write %s", (column) => {
    expect(inPaginated.has(column), `the paginated path never writes ${column}`).toBe(true);
    expect(
      branches.create.has(column),
      `the bulk path does not write ${column} when it first sees a variant — so a store ` +
        `large enough to take that path gets it empty, and only large stores are affected`,
    ).toBe(true);
    expect(
      branches.update.has(column),
      `the bulk path does not write ${column} when it re-syncs a variant — so it is ` +
        `right once and wrong from the second sync onwards, which looks like it worked`,
    ).toBe(true);
  });

  it("fetches the image on both paths, not just one", () => {
    // Writing a column the query never asked for is the same bug wearing a different hat.
    expect(paginated).toContain("featuredImage { url }");
    expect(paginated).toContain("image { url }");
    expect(
      sourceOf(process.cwd(), "app", "lib", "catalog", "bulk-jsonl.ts"),
    ).toContain("featuredImage { url }");
  });
});
