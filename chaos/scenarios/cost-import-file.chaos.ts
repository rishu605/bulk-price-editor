/**
 * A cost file is accounted for row by row, and an import says what it did (#767).
 *
 * - A variant listed twice was written twice, the last row winning without a word. Since
 *   #989 (D17) the first row is used and each later one is refused, naming the row it
 *   repeats, as the price and baseline imports do.
 * - Unchanged rows were in none of the counts, so the tiles did not add up to the file.
 * - A committed import left nothing in Activity.
 * - A commit that failed part way said nothing of the batches it had already written.
 *
 * Through the cost importer itself, on a catalogue with SKUs.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { costErrorCsv } from "../../app/lib/reporting/cost-errors";
import { importCosts } from "../../app/services/cost-import.server";
import { withChaos } from "../harness/scenario";

async function* lines(text: string[]) {
  for (const line of text) yield line;
}

describe("chaos: a cost file", () => {
  it("uses a variant's first row and refuses the repeat, adds up, and is audited without its costs", async () => {
    await withChaos("cost-import-file", { catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `CF-${i}`, cost: i === 3 ? 700n : null } }),
        ),
      );
      const since = new Date(Date.now() - 1000);
      const file = [
        "Variant SKU,Variant Cost",
        "CF-0,4.00",
        "CF-1,5.00",
        "CF-0,4.50", // the same variant again
        "CF-3,7.00", // unchanged
        "NOPE,1.00", // no match
      ];

      const result = await importCosts(shopId, lines(file), "USD", { actor: "staff:42" });

      expect(result.duplicates.map((p) => p.line), "the first row was refused too").toEqual([4]);
      expect(result.duplicates[0].reason).toMatch(/^Line 4 repeats this variant's line 2; only line 2 is used\./);
      expect(result).toMatchObject({ total: 5, ready: 2, unchanged: 1, written: 2, problems: 2 });
      expect(result.total, "the counts do not account for the file").toBe(result.ready + result.unchanged + result.problems);

      const cost = async (i: number) =>
        (await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: variantGids[i] } })).cost;
      expect(await cost(0), "the first row's cost was not the one written").toBe(400n);
      expect(await cost(1)).toBe(500n);

      const audit = await prisma.auditLogEntry.findMany({ where: { shopId, action: "costs.import", createdAt: { gte: since } } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe("staff:42");
      expect(audit[0].after).toEqual({ total: 5, written: 2, unchanged: 1, problems: 2 });

      // A dry run writes nothing and records nothing.
      await importCosts(shopId, lines(file), "USD", { dryRun: true, actor: "staff:42" });
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "costs.import", createdAt: { gte: since } } })).toBe(1);
    });
  });

  it("refuses every repeat of a variant against its first row, even one that changes nothing, in the check and the commit alike", async () => {
    await withChaos("cost-import-repeats", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `CR-${i}`, cost: i === 1 ? 500n : null } }),
        ),
      );
      const file = [
        "Variant SKU,Variant Cost",
        "CR-1,5.00", // line 2: unchanged, and still the row used for CR-1
        "CR-0,4.00", // line 3
        "CR-1,6.00", // line 4: repeats line 2
        "CR-0,4.50", // line 5: repeats line 3
        "CR-1,7.00", // line 6: repeats line 2, not line 4
      ];
      const repeats = (result: { duplicates: Array<{ line: number; reason: string }> }) =>
        result.duplicates.map((p) => [p.line, Number(/line (\d+);/.exec(p.reason)?.[1])]);

      // What the check shows is what the commit does.
      const checked = await importCosts(shopId, lines(file), "USD", { dryRun: true });
      expect(repeats(checked)).toEqual([[4, 2], [5, 3], [6, 2]]);
      expect(checked).toMatchObject({ total: 5, ready: 1, unchanged: 1, problems: 3 });
      expect(checked.total).toBe(checked.ready + checked.unchanged + checked.problems);

      // The download carries every refused repeat, as its own kind.
      const download = costErrorCsv(checked).trimEnd().split("\n").slice(1);
      expect(download.map((row) => row.split(",").slice(0, 3).join(","))).toEqual([
        '"4","CR-1","duplicate"',
        '"5","CR-0","duplicate"',
        '"6","CR-1","duplicate"',
      ]);

      const committed = await importCosts(shopId, lines(file), "USD", { actor: "staff:42" });
      expect(repeats(committed)).toEqual(repeats(checked));
      expect(committed).toMatchObject({ total: 5, ready: 1, unchanged: 1, written: 1, problems: 3 });

      const cost = async (i: number) =>
        (await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: variantGids[i] } })).cost;
      expect(await cost(0)).toBe(400n);
      expect(await cost(1), "a repeat overrode the variant's first row").toBe(500n);
    });
  });

  it("says how many costs it wrote when a commit fails part way", async () => {
    await withChaos("cost-import-partial", { catalog: { products: 600, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await prisma.$transaction(
        variantGids.map((gid, i) => prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `PART-${i}`, cost: null } })),
      );
      const file = ["Variant SKU,Variant Cost", ...variantGids.map((_, i) => `PART-${i},3.00`)];

      // The first batch of 500 is written; the second fails.
      const original = prisma.$transaction.bind(prisma);
      let calls = 0;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((arg: never) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("chaos: the database went away"));
        return original(arg);
      }) as never);

      const thrown = await importCosts(shopId, lines(file), "USD", { actor: "staff:42" }).catch((error: unknown) => error);
      spy.mockRestore();

      expect((thrown as { userMessage?: string }).userMessage, "a part-written import did not say how far it got").toMatch(
        /500 of 600 costs were written before it stopped/,
      );
      expect(await prisma.variantIndex.count({ where: { shopId, cost: 300n } })).toBe(500);
    });
  });
});
