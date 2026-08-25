/**
 * Importing costs, and the round trip through a spreadsheet.
 *
 * The margin guardrail is the safety feature merchants ask for most, and on most
 * catalogues it protects nothing because Shopify does not require a cost. This is what
 * makes it real — so the thing worth testing is that an imported cost actually reaches
 * the guardrail, not merely that a row was written somewhere.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/** The pasted-file shape both importers consume. */
async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

describe("chaos: importing costs", () => {
  it("writes costs the margin guardrail can actually use", async () => {
    await withChaos(
      "cost-import",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        // SKUs, because that is what a merchant's spreadsheet has.
        await Promise.all(
          variantGids.map((gid, i) =>
            prisma.variantIndex.updateMany({
              where: { shopId, variantGid: gid },
              data: { sku: `SKU-${i}` },
            }),
          ),
        );

        const { importCosts } = await import("../../app/services/cost-import.server");
        const file = ["Variant SKU,Variant Cost", ...variantGids.map((_, i) => `SKU-${i},10.00`)]
          .join("\n");

        // Dry run writes nothing. Not a nicety: it is the same code path with the write
        // skipped, so what the merchant reviews is what happens.
        const preview = await importCosts(shopId, linesOf(file), "USD", { dryRun: true });
        expect(preview.ready).toBe(variantGids.length);
        expect(preview.written).toBe(0);
        expect(
          await prisma.variantIndex.count({ where: { shopId, cost: { not: null } } }),
        ).toBe(0);

        const real = await importCosts(shopId, linesOf(file), "USD");
        expect(real.written).toBe(variantGids.length);

        // Both places, because the guardrail reads the baseline at resolve time and the
        // settings page counts the mirror. Writing one and not the other would show a
        // merchant "100% cost coverage" over a guardrail still skipping everything.
        expect(
          await prisma.variantIndex.count({ where: { shopId, cost: BigInt(1000) } }),
        ).toBe(variantGids.length);
        expect(
          await prisma.baseline.count({
            where: { shopId, supersededAt: null, cost: BigInt(1000) },
          }),
        ).toBe(variantGids.length);
      },
    );
  });

  it("stops a campaign pricing below an imported cost", async () => {
    await withChaos(
      "cost-import-guardrail",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -90 },
      async (chaos) => {
        const { shopId, variantGids, baseline } = chaos.fixture;

        await Promise.all(
          variantGids.map((gid, i) =>
            prisma.variantIndex.updateMany({
              where: { shopId, variantGid: gid },
              data: { sku: `SKU-${i}` },
            }),
          ),
        );

        // A cost just under each baseline, so a 90% discount is plainly below it.
        const { importCosts } = await import("../../app/services/cost-import.server");
        const file = [
          "Variant SKU,Variant Cost",
          ...variantGids.map((gid, i) => `SKU-${i},${((baseline.get(gid)! * 0.9) / 100).toFixed(2)}`),
        ].join("\n");

        await importCosts(shopId, linesOf(file), "USD");

        // Switch the guardrail on. Before the import this setting did nothing at all,
        // because every variant was skipped for having no cost.
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        await prisma.shop.update({
          where: { id: shopId },
          data: {
            settings: {
              ...((shop.settings ?? {}) as object),
              neverBelowCost: true,
              violationPolicy: "clamp",
              missingCostPolicy: "skip",
            } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Every price clamped up to the cost floor rather than landing at 10% of
        // baseline. Asserted against the imported cost itself, not against a fraction of
        // the baseline: the claim is "no campaign priced below cost", and only the cost
        // can test that.
        for (const gid of variantGids) {
          const floor = Math.round(baseline.get(gid)! * 0.9);
          const live = Number(chaos.fake.priceOf(gid)!.replace(".", ""));

          expect(live).toBeGreaterThanOrEqual(floor);
          // And it really was clamped rather than left alone — a 90% discount would
          // have landed far below this.
          expect(live).toBeLessThan(baseline.get(gid)!);
        }

        const clamped = await prisma.variantChange.count({
          where: { runId: applied.runId, status: "VERIFIED" },
        });
        expect(clamped).toBe(variantGids.length);
      },
    );
  });

  it("reports a bad row without failing the file", async () => {
    await withChaos(
      "cost-import-errors",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        await Promise.all(
          variantGids.map((gid, i) =>
            prisma.variantIndex.updateMany({
              where: { shopId, variantGid: gid },
              data: { sku: `SKU-${i}` },
            }),
          ),
        );

        const { importCosts } = await import("../../app/services/cost-import.server");
        const file = [
          "Variant SKU,Variant Cost",
          "SKU-0,10.00",
          "SKU-1,$12.50",      // currency symbol
          "NOPE-9,10.00",      // matches nothing
          "SKU-2,10.00",
        ].join("\n");

        const result = await importCosts(shopId, linesOf(file), "USD");

        // One malformed row must not reject the file. A merchant who has to find the
        // single bad line before anything happens is a merchant who gives up.
        expect(result.written).toBe(2);
        expect(result.invalid).toHaveLength(1);
        expect(result.unmatched).toHaveLength(1);
        expect(result.invalid[0].line).toBe(3);
        expect(result.unmatched[0].identifier).toBe("NOPE-9");
      },
    );
  });

  it("survives a 50,000-row file without assembling it", async () => {
    await withChaos(
      "cost-import-scale",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: variantGids[0] },
          data: { sku: "SKU-REAL" },
        });

        // Generated lazily, so the test itself never holds the file either — which is
        // the property being asserted. Most rows match nothing, which is the realistic
        // shape of a merchant pasting their whole ERP export at a partial catalogue.
        async function* rows(): AsyncGenerator<string> {
          yield "Variant SKU,Variant Cost";
          yield "SKU-REAL,10.00";
          for (let i = 0; i < 50_000; i++) yield `SKU-MISSING-${i},10.00`;
        }

        const { importCosts } = await import("../../app/services/cost-import.server");
        const before = process.memoryUsage().heapUsed;
        const result = await importCosts(shopId, rows(), "USD");
        const growth = process.memoryUsage().heapUsed - before;

        expect(result.total).toBe(50_001);
        expect(result.written).toBe(1);

        // Problems are capped rather than accumulated. Fifty thousand unmatched rows
        // must produce a usable list and a count, not an out-of-memory.
        expect(result.unmatched.length).toBeLessThanOrEqual(500);
        // Well under what holding 50K rows plus 50K problem objects would cost.
        expect(growth).toBeLessThan(120 * 1024 * 1024);
      },
    );
  });
});
