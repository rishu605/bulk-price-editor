/**
 * Importing exact prices, as a campaign.
 *
 * The point of doing it this way rather than writing the prices directly is that
 * everything else comes for free — preview, guardrails, rounding, markets, revert. So the
 * tests are mostly "does an imported campaign behave like any other campaign", because if
 * it does not, the architecture bought nothing.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

/** SKUs, because that is what a merchant's spreadsheet has. */
async function giveSkus(chaos: ChaosContext) {
  const { shopId, variantGids } = chaos.fixture;
  await Promise.all(
    variantGids.map((gid, i) =>
      prisma.variantIndex.updateMany({
        where: { shopId, variantGid: gid },
        data: { sku: `SKU-${i}` },
      }),
    ),
  );
}

/** Points the fixture's campaign at an import rather than a percentage. */
async function useImport(campaignId: string, importId: string) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { ruleRows: [{ segmentIds: [], rule: { kind: "from-import", importId } }] as never },
  });
}

describe("chaos: importing exact prices", () => {
  it("writes each product the price its row named", async () => {
    await withChaos(
      "price-import",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await giveSkus(chaos);

        const { importPrices } = await import("../../app/services/price-import.server");
        const file = [
          "Variant SKU,Variant Price",
          ...variantGids.map((_, i) => `SKU-${i},${(10 + i).toFixed(2)}`),
        ].join("\n");

        const imported = await importPrices(shopId, "Spring list", linesOf(file), "USD");
        expect(imported.ready).toBe(variantGids.length);

        await useImport(campaignId, imported.importId!);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // One answer per product, which is the thing a rule cannot express.
        variantGids.forEach((gid, i) => {
          expect(chaos.fake.priceOf(gid)).toBe((10 + i).toFixed(2));
        });
      },
    );
  });

  it("skips a product the file did not name, and says why", async () => {
    await withChaos(
      "price-import-partial-file",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
        await giveSkus(chaos);

        const { importPrices } = await import("../../app/services/price-import.server");
        // Only three of five.
        const file = ["Variant SKU,Variant Price", "SKU-0,10.00", "SKU-1,11.00", "SKU-2,12.00"]
          .join("\n");

        const imported = await importPrices(shopId, "Partial", linesOf(file), "USD");
        await useImport(campaignId, imported.importId!);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // The two the file missed keep their prices rather than being set to nothing.
        // Skipped, with a reason — not an error, and certainly not zero.
        for (const gid of variantGids.slice(3)) {
          const live = Number(chaos.fake.priceOf(gid)!.replace(".", ""));
          expect(live).toBe(baseline.get(gid));
        }

        // Counted on the run rather than ledgered. A skipped row was never going to be
        // written, so giving it a ledger entry would put two rows in the record of "what
        // we did to this storefront" that describe nothing having been done.
        const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: applied.runId } });
        expect(run.skippedRows).toBe(2);

        // And the merchant is told, rather than left to notice two products missing.
        expect(applied.messages.join(" ")).toContain("skipped");
      },
    );
  });

  it("is still subject to guardrails, like any other campaign", async () => {
    await withChaos(
      "price-import-guardrail",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await giveSkus(chaos);

        // Costs at $20, and a file that prices everything at $5.
        const { importCosts } = await import("../../app/services/cost-import.server");
        await importCosts(
          shopId,
          linesOf(["Variant SKU,Variant Cost", ...variantGids.map((_, i) => `SKU-${i},20.00`)].join("\n")),
          "USD",
        );

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

        const { importPrices } = await import("../../app/services/price-import.server");
        const imported = await importPrices(
          shopId,
          "Too cheap",
          linesOf(["Variant SKU,Variant Price", ...variantGids.map((_, i) => `SKU-${i},5.00`)].join("\n")),
          "USD",
        );
        await useImport(campaignId, imported.importId!);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Clamped to cost, not written at $5. This is the whole argument for routing an
        // import through a campaign: a direct write would have been the one path in the
        // app with no floor under it.
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe("20.00");
        }
      },
    );
  });

  it("reverts by recomputing, like any other campaign", async () => {
    await withChaos(
      "price-import-revert",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
        await giveSkus(chaos);

        const { importPrices } = await import("../../app/services/price-import.server");
        const imported = await importPrices(
          shopId,
          "Spring",
          linesOf(["Variant SKU,Variant Price", ...variantGids.map((_, i) => `SKU-${i},7.00`)].join("\n")),
          "USD",
        );
        await useImport(campaignId, imported.importId!);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const reverted = await chaos.revert();
        await chaos.expectHonest(reverted.runId);

        for (const gid of variantGids) {
          const live = Number(chaos.fake.priceOf(gid)!.replace(".", ""));
          expect(live).toBe(baseline.get(gid));
        }
      },
    );
  });

  it("refuses a file that names one variant twice", async () => {
    await withChaos(
      "price-import-duplicate",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        await giveSkus(chaos);

        const { importPrices } = await import("../../app/services/price-import.server");
        const result = await importPrices(
          shopId,
          "Conflicting",
          linesOf(["Variant SKU,Variant Price", "SKU-0,10.00", "SKU-1,11.00", "SKU-0,99.00"].join("\n")),
          "USD",
        );

        // A file naming a variant twice is a question, not two instructions. Letting the
        // last row win would set a price the merchant may not have meant, silently.
        expect(result.ready).toBe(2);
        expect(result.duplicates).toHaveLength(1);
        expect(result.duplicates[0].line).toBe(4);

        const stored = await prisma.priceImportRow.findMany({
          where: { importId: result.importId! },
        });
        expect(stored).toHaveLength(2);
        // The first row won, and the merchant was told about the second.
        expect(stored.find((row) => Number(row.price) === 9_900)).toBeUndefined();
      },
    );
  });

  it("writes nothing on a dry run, not even the import", async () => {
    await withChaos(
      "price-import-dry",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        await giveSkus(chaos);

        const { importPrices } = await import("../../app/services/price-import.server");
        const result = await importPrices(
          shopId,
          "Preview only",
          linesOf(["Variant SKU,Variant Price", "SKU-0,10.00"].join("\n")),
          "USD",
          { dryRun: true },
        );

        expect(result.ready).toBe(1);
        expect(result.importId).toBeNull();
        // A dry run that created and deleted an import would not be a dry run.
        expect(await prisma.priceImport.count({ where: { shopId } })).toBe(0);
      },
    );
  });
});
