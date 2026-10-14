/**
 * A cost file is accounted for row by row, and an import says what it did (#767).
 *
 * - A variant listed twice was written twice, the last row winning without a word.
 * - Unchanged rows were in none of the counts, so the tiles did not add up to the file.
 * - A committed import left nothing in Activity.
 * - A commit that failed part way said nothing of the batches it had already written.
 *
 * Through the cost importer itself, on a catalogue with SKUs.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { importCosts } from "../../app/services/cost-import.server";
import { withChaos } from "../harness/scenario";

async function* lines(text: string[]) {
  for (const line of text) yield line;
}

describe("chaos: a cost file", () => {
  it("refuses a variant listed twice, adds up, and is audited without its costs", async () => {
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

      expect(result.duplicates.map((p) => p.line)).toEqual([2, 4]);
      expect(result.duplicates[0].reason).toMatch(/listed 2 times \(lines 2, 4\).*neither was imported/);
      expect(result).toMatchObject({ total: 5, ready: 1, unchanged: 1, written: 1, problems: 3 });
      expect(result.total, "the counts do not account for the file").toBe(result.ready + result.unchanged + result.problems);

      const cost = async (i: number) =>
        (await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: variantGids[i] } })).cost;
      expect(await cost(0), "a variant listed twice was written").toBeNull();
      expect(await cost(1)).toBe(500n);

      const audit = await prisma.auditLogEntry.findMany({ where: { shopId, action: "costs.import", createdAt: { gte: since } } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe("staff:42");
      expect(audit[0].after).toEqual({ total: 5, written: 1, unchanged: 1, problems: 3 });

      // A dry run writes nothing and records nothing.
      await importCosts(shopId, lines(file), "USD", { dryRun: true, actor: "staff:42" });
      expect(await prisma.auditLogEntry.count({ where: { shopId, action: "costs.import", createdAt: { gte: since } } })).toBe(1);
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
