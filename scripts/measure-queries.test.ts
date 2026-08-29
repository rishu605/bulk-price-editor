/**
 * What the query harness concludes from a plan.
 *
 * The numbers need a hundred thousand variants; the reading of them does not. And the
 * reading is where a harness like this fails silently — by finding no full scan in a plan
 * that has one, and reporting a clean bill of health for a catalogue it did look at. That
 * is worse than not running it, because it is the result somebody quotes.
 *
 * Postgres nests the interesting node inside three or four wrappers (Aggregate over
 * Gather over Nested Loop over the scan), so "did anything read a whole table" is a
 * question about the whole tree and never about its root.
 */

import { describe, expect, it } from "vitest";

import { NOT_EXPLAINABLE, parseParams, summarise, walk } from "./measure-queries";

/** The shape Postgres returns for `EXPLAIN (FORMAT JSON)`, trimmed to what is read. */
const node = (
  type: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({ "Node Type": type, ...over });

describe("finding the scans", () => {
  it("reports a sequential scan at the root", () => {
    const plan = summarise("select 1", node("Seq Scan", { "Relation Name": "variant_index" }), 12);

    expect(plan.scannedRelations).toEqual(["variant_index"]);
  });

  it("finds one buried under the aggregate that Prisma's counts always add", () => {
    // Every `count()` Prisma emits arrives as Aggregate → Subquery Scan → the real node.
    // A check that looked only at the root would call every count in the app indexed.
    const plan = summarise(
      "select count(*)",
      node("Aggregate", {
        Plans: [
          node("Subquery Scan", {
            Plans: [node("Seq Scan", { "Relation Name": "baselines" })],
          }),
        ],
      }),
      40,
    );

    expect(plan.scannedRelations).toEqual(["baselines"]);
  });

  it("counts a parallel sequential scan as a full scan", () => {
    // Postgres names it differently once it parallelises, and a table read by three
    // workers is still a table read.
    const plan = summarise(
      "select 1",
      node("Gather", {
        Plans: [node("Parallel Seq Scan", { "Relation Name": "variant_index" })],
      }),
      9,
    );

    expect(plan.scannedRelations).toEqual(["variant_index"]);
  });

  it("names each scanned relation once however often it appears", () => {
    const plan = summarise(
      "select 1",
      node("Hash Join", {
        Plans: [
          node("Seq Scan", { "Relation Name": "baselines" }),
          node("Seq Scan", { "Relation Name": "baselines" }),
        ],
      }),
      3,
    );

    expect(plan.scannedRelations).toEqual(["baselines"]);
  });

  it("reports nothing for a plan served entirely by indexes", () => {
    const plan = summarise(
      "select 1",
      node("Aggregate", {
        Plans: [
          node("Bitmap Heap Scan", {
            "Relation Name": "variant_index",
            Plans: [node("Bitmap Index Scan", { "Relation Name": "variant_index_tags_gin" })],
          }),
        ],
      }),
      4,
    );

    expect(plan.scannedRelations).toEqual([]);
  });
});

describe("rows discarded", () => {
  it("multiplies by the loop count", () => {
    // A scan inside a nested loop reports its per-iteration figure. Reporting that
    // number understates the work by however many times the loop ran, which on a
    // chunked `IN` list is the difference between 900 rows and four million.
    const plan = summarise(
      "select 1",
      node("Nested Loop", {
        Plans: [node("Seq Scan", { "Rows Removed by Filter": 900, "Actual Loops": 21 })],
      }),
      50,
    );

    expect(plan.rowsRemovedByFilter).toBe(18_900);
  });

  it("sums across every node in the tree", () => {
    const plan = summarise(
      "select 1",
      node("Hash Join", {
        "Rows Removed by Filter": 5,
        Plans: [node("Seq Scan", { "Rows Removed by Filter": 10 })],
      }),
      1,
    );

    expect(plan.rowsRemovedByFilter).toBe(15);
  });
});

describe("sorts that spill to disk", () => {
  it("reports the kilobytes a disk sort wrote", () => {
    // The finding that a timing alone cannot give you. A spilling sort is a cliff, not a
    // slope — fast until the data outgrows work_mem, then not — and the plan node is a
    // `Sort` either way. Only `Sort Space Type` distinguishes them.
    const plan = summarise(
      "select 1",
      node("Unique", {
        Plans: [
          node("Sort", {
            "Sort Method": "external merge",
            "Sort Space Used": 9072,
            "Sort Space Type": "Disk",
          }),
        ],
      }),
      1018,
    );

    expect(plan.diskSortKb).toEqual([9072]);
  });

  it("says nothing about a sort that fit in memory", () => {
    const plan = summarise(
      "select 1",
      node("Sort", {
        "Sort Method": "quicksort",
        "Sort Space Used": 5887,
        "Sort Space Type": "Memory",
      }),
      3,
    );

    expect(plan.diskSortKb).toEqual([]);
  });

  it("multiplies a spill inside a loop by its iterations", () => {
    const plan = summarise(
      "select 1",
      node("Nested Loop", {
        Plans: [
          node("Sort", { "Sort Space Used": 100, "Sort Space Type": "Disk", "Actual Loops": 21 }),
        ],
      }),
      1,
    );

    expect(plan.diskSortKb).toEqual([2100]);
  });

  it("reports each spilling sort separately", () => {
    const plan = summarise(
      "select 1",
      node("Merge Join", {
        Plans: [
          node("Sort", { "Sort Space Used": 10, "Sort Space Type": "Disk" }),
          node("Sort", { "Sort Space Used": 20, "Sort Space Type": "Disk" }),
        ],
      }),
      1,
    );

    expect(plan.diskSortKb).toEqual([10, 20]);
  });
});

describe("buffers", () => {
  it("adds cache hits and disk reads across the tree", () => {
    const plan = summarise(
      "select 1",
      node("Aggregate", {
        "Shared Hit Blocks": 10,
        "Shared Read Blocks": 2,
        Plans: [node("Seq Scan", { "Shared Hit Blocks": 100, "Shared Read Blocks": 30 })],
      }),
      1,
    );

    expect(plan.sharedBlocks).toBe(142);
  });
});

describe("walking the tree", () => {
  it("returns every node, parents before children", () => {
    const types = walk(
      node("A", { Plans: [node("B", { Plans: [node("C")] }), node("D")] }),
    ).map((n) => n["Node Type"]);

    expect(types).toEqual(["A", "B", "C", "D"]);
  });

  it("handles a leaf with no children", () => {
    expect(walk(node("Seq Scan"))).toHaveLength(1);
  });
});

describe("the statements EXPLAIN will not take", () => {
  it.each(["BEGIN", "COMMIT", "ROLLBACK", "DEALLOCATE ALL", "SET NAMES", "SAVEPOINT s1"])(
    "skips %s",
    (sql) => {
      expect(NOT_EXPLAINABLE.test(sql)).toBe(true);
    },
  );

  it("skips one Prisma sent with leading whitespace", () => {
    expect(NOT_EXPLAINABLE.test("  begin")).toBe(true);
  });

  it("does not skip a select that merely begins with a matching word", () => {
    // `\b` on the keyword, so a column called `settings` in a real query cannot make
    // the harness quietly ignore the statement that reads it.
    expect(NOT_EXPLAINABLE.test('SELECT "settings" FROM shops')).toBe(false);
  });
});

describe("the parameters Prisma logs", () => {
  it("parses a scalar list", () => {
    expect(parseParams('["shop_1","ACTIVE",0]')).toEqual(["shop_1", "ACTIVE", 0]);
  });

  it("keeps a nested array, which is what a tag filter binds", () => {
    // `tags @> $2` binds an array. Flattening it would make the EXPLAIN fail and the
    // path silently report no plans at all.
    expect(parseParams('["shop_1",["sale"]]')).toEqual(["shop_1", ["sale"]]);
  });

  it("gives back nothing for a statement with no parameters", () => {
    expect(parseParams("[]")).toEqual([]);
  });

  it("gives back nothing rather than throwing on a log line it cannot read", () => {
    expect(parseParams("not json")).toEqual([]);
  });
});
