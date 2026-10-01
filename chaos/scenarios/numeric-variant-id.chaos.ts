/**
 * Every importer matches a numeric Variant ID (#774).
 *
 * Shopify's admin and Matrixify write a variant as a plain number -- `46172975661290` --
 * and every importer says a row can be keyed by "a SKU, barcode or variant ID". The matcher
 * read the number as a barcode and never looked it up as a variant, so a Matrixify export
 * came back "No match" on every row of every importer.
 *
 * A real Matrixify Products header row, keyed by its Variant ID, through all four
 * importers against the real database. The fixture's own variants have non-numeric ids, so
 * the catalogue gets three with Shopify-shaped ones.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { importBaselines } from "../../app/services/baseline-import.server";
import { importCosts } from "../../app/services/cost-import.server";
import { importPrices } from "../../app/services/price-import.server";
import { matchCsv } from "../../app/services/segments-crud.server";
import { withChaos } from "../harness/scenario";

const IDS = ["46172975661290", "46172975694058", "46172975726826"];
const gid = (id: string) => `gid://shopify/ProductVariant/${id}`;

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

/** The columns a Matrixify Products export carries, keyed by its Variant ID. */
const MATRIXIFY = [
  "ID,Handle,Variant ID,Variant SKU,Variant Barcode,Variant Price,Variant Compare At Price,Variant Cost",
  ...IDS.map((id, i) => `9001,cascade-gloves-44,${id},CG44-${i},,${(100 + i).toFixed(2)},,${(40 + i).toFixed(2)}`),
].join("\n");

describe("chaos: a file keyed by numeric Variant IDs", () => {
  it("matches in the price, cost, baseline and segment importers", async () => {
    await withChaos("numeric-variant-id", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      await prisma.variantIndex.createMany({
        data: IDS.map((id, i) => ({
          shopId,
          variantGid: gid(id),
          productGid: "gid://shopify/Product/9001",
          title: `Cascade Gloves 44 · ${i}`,
          // A SKU that is *not* in the file, so only the variant id can match.
          sku: `OTHER-${i}`,
          price: 9000n,
          currency: "USD",
          status: "ACTIVE" as const,
          tags: [],
        })),
      });

      const prices = await importPrices(shopId, "Matrixify prices", linesOf(MATRIXIFY), "USD", { dryRun: true });
      expect(prices.ready, "price import: every row came back No match").toBe(IDS.length);

      const costs = await importCosts(shopId, linesOf(MATRIXIFY), "USD", { dryRun: true });
      expect(costs.ready, "cost import").toBe(IDS.length);

      const baselines = await importBaselines(shopId, linesOf(MATRIXIFY), "USD", { dryRun: true });
      expect(baselines.ready, "baseline import").toBe(IDS.length);

      // The segment importer reads the first column; a file headed Variant ID says what
      // its numbers are.
      const segment = await matchCsv(shopId, ["Variant ID", ...IDS].join("\n"));
      expect(segment.matched.sort(), "segment import").toEqual(IDS.map(gid).sort());
      expect(segment.unmatched).toEqual([]);
    });
  });
});
