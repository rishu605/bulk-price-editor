/**
 * A baseline file naming a variant twice says so on the dry run, and never half-applies (#736).
 *
 * Both rows counted as ready on the dry run. On commit the second hit the one-current-
 * baseline index after earlier 500-row batches had been written: an error for a file the
 * preview called clean, with part of it already in effect. The duplicate here sits in the
 * second batch, after the first has been flushed.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { importBaselines } from "../../app/services/baseline-import.server";
import { withChaos } from "../harness/scenario";

const VARIANTS = 510;

async function* lines(text: string[]) {
  for (const line of text) yield line;
}

describe("chaos: a baseline file that names a variant twice", () => {
  it("reports the second row on the dry run, and the commit writes every other row once", async () => {
    await withChaos("baseline-import-twice", { catalog: { products: VARIANTS, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await prisma.$transaction(
        variantGids.map((gid, i) => prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `TWICE-${i}` } })),
      );
      const file = [
        "Variant SKU,Variant Price",
        ...variantGids.map((_, i) => `TWICE-${i},${(20 + i / 100).toFixed(2)}`),
        // The first variant again, in the second batch, at a different price.
        "TWICE-0,22.00",
      ];

      const dry = await importBaselines(shopId, lines(file), "USD", { dryRun: true });
      expect(dry.ready, "both rows for one variant counted as ready").toBe(VARIANTS);
      expect(dry.duplicates.map((p) => [p.line, p.identifier])).toEqual([[VARIANTS + 2, "TWICE-0"]]);

      const committed = await importBaselines(shopId, lines(file), "USD");
      expect(committed.written).toBe(VARIANTS);
      expect(committed.duplicates).toHaveLength(1);

      const current = await prisma.baseline.findMany({
        where: { shopId, surfaceKind: "BASE", supersededAt: null, variantGid: { in: variantGids } },
        select: { variantGid: true, basePrice: true },
      });
      expect(current).toHaveLength(VARIANTS);
      // The first row's price, not the repeat's.
      expect(current.find((row) => row.variantGid === variantGids[0])?.basePrice).toBe(2000n);
    });
  });
});
