/**
 * Importing a merchant's own reference prices.
 *
 * A baseline is permanent and every campaign computes from it, so a wrong one silently
 * mis-prices a product on every campaign from here on. That makes two properties worth
 * pinning down against a real database rather than a mock:
 *
 *   A dry run writes nothing at all. It is the same code path with the write skipped,
 *   so what the merchant reviews is exactly what happens — not a second implementation
 *   free to disagree with the first.
 *
 *   One bad row costs that row. On five hundred thousand rows, a malformed price must
 *   not reject the file; a merchant who has to find the single bad line before anything
 *   happens gives up on the import.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { importBaselines, importErrorCsv } from "../../app/services/baseline-import.server";
import { withChaos } from "../harness/scenario";

async function* lines(...items: string[]) {
  for (const item of items) yield item;
}

describe("chaos: importing baselines from a file", () => {
  it("dry run reports exactly what a real run does, and writes nothing", async () => {
    await withChaos(
      "baseline-import",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids, baseline } = chaos.fixture;

        // Real gids, one row that will not validate, one that matches nothing.
        const file = () =>
          lines(
            "sku,price,compare_at",
            `${variantGids[0]},250.00,400.00`,
            `${variantGids[1]},175.50,`,
            `${variantGids[2]},0.00,`,
            "NOT-A-REAL-SKU,10.00,",
          );

        const before = await prisma.baseline.count({ where: { shopId, supersededAt: null } });

        const dry = await importBaselines(shopId, file(), "USD", { dryRun: true });

        expect(dry.dryRun).toBe(true);
        expect(dry.total).toBe(4);
        expect(dry.ready).toBe(2);
        expect(dry.written).toBe(0);
        expect(dry.invalid).toHaveLength(1);
        expect(dry.invalid[0].reason).toMatch(/above zero/i);
        expect(dry.unmatched).toHaveLength(1);

        // Nothing moved. Not one row, not one superseded flag.
        expect(await prisma.baseline.count({ where: { shopId, supersededAt: null } })).toBe(before);
        expect(await prisma.baseline.count({ where: { shopId, supersededAt: { not: null } } })).toBe(0);

        // The error file is the artefact the merchant fixes and re-uploads.
        const csv = importErrorCsv(dry);
        expect(csv).toContain("NOT-A-REAL-SKU");
        expect(csv.split("\n")[0]).toContain("what_to_do");

        // ------------------------------------------------------ for real now
        const real = await importBaselines(shopId, file(), "USD", { actor: "staff:1" });

        expect(real.written).toBe(2);
        // The dry run promised exactly this.
        expect(real.ready).toBe(dry.ready);
        expect(real.invalid).toHaveLength(dry.invalid.length);
        expect(real.unmatched).toHaveLength(dry.unmatched.length);

        const imported = await prisma.baseline.findFirstOrThrow({
          where: { shopId, variantGid: variantGids[0], supersededAt: null },
        });
        expect(imported.basePrice).toBe(25_000n);
        expect(imported.baseCompareAt).toBe(40_000n);
        expect(imported.source).toBe("CSV_IMPORT");

        // Append-only: the old baseline is superseded, not overwritten, so what the
        // reference price used to be — and when it changed — survives.
        const superseded = await prisma.baseline.findFirstOrThrow({
          where: { shopId, variantGid: variantGids[0], supersededAt: { not: null } },
        });
        expect(Number(superseded.basePrice)).toBe(baseline.get(variantGids[0]));

        // The row that failed validation kept its original baseline untouched.
        const untouched = await prisma.baseline.findFirstOrThrow({
          where: { shopId, variantGid: variantGids[2], supersededAt: null },
        });
        expect(Number(untouched.basePrice)).toBe(baseline.get(variantGids[2]));
      },
    );
  });

  it("re-importing the same file changes nothing and says so", async () => {
    await withChaos(
      "baseline-import-idempotent",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const file = () => lines("sku,price", `${variantGids[0]},99.00`);

        const first = await importBaselines(shopId, file(), "USD");
        expect(first.written).toBe(1);

        // Re-capturing an identical baseline would supersede the existing row and lose
        // the date the reference price was first established.
        const second = await importBaselines(shopId, file(), "USD");
        expect(second.written).toBe(0);
        expect(second.unchanged).toBe(1);

        expect(
          await prisma.baseline.count({
            where: { shopId, variantGid: variantGids[0], supersededAt: { not: null } },
          }),
        ).toBe(1);
      },
    );
  });

  it("refuses a product ID rather than giving several variants one baseline", async () => {
    await withChaos(
      "baseline-import-ambiguous",
      { catalog: { products: 1, variantsPerProduct: 3 }, percent: -10 },
      async (chaos) => {
        const { shopId, productOf, variantGids } = chaos.fixture;
        const productGid = productOf.get(variantGids[0])!;

        const result = await importBaselines(
          shopId,
          lines("sku,price", `${productGid},50.00`),
          "USD",
          { dryRun: true },
        );

        // Legitimate for a segment — "everything in this product" — and meaningless
        // for a baseline, where one row would have to mean one price for three
        // different variants.
        expect(result.ready).toBe(0);
        expect(result.ambiguous).toHaveLength(1);
        expect(result.ambiguous[0].reason).toMatch(/3 variants/);
      },
    );
  });
});
