/**
 * Spreadsheet imports read the identifiers merchants' exports actually carry (#735).
 *
 * - A file keyed by Handle was looked up as SKUs, which handles never are: every row came
 *   back "No match", with nothing saying why. It is refused, row by row, with the reason.
 * - A product id matches every variant of the product; the price and cost imports took the
 *   first and dropped the rest without a word. Refused, as the baseline import refuses it.
 * - A Shopify product export, Handle first and no Variant ID, matches by its Variant SKU.
 *
 * Through the price and cost importers themselves, on a catalogue of two products with two
 * variants each.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { HANDLE_REFUSAL } from "../../app/lib/baselines/csv-rows";
import { importCosts } from "../../app/services/cost-import.server";
import { importPrices } from "../../app/services/price-import.server";
import { withChaos } from "../harness/scenario";

async function* lines(text: string) {
  for (const line of text.split("\n")) yield line;
}

describe("chaos: the identifiers an export carries", () => {
  it("refuses handles and whole products with the reason, and matches a Shopify export by SKU", async () => {
    await withChaos("import-identifiers", { catalog: { products: 2, variantsPerProduct: 2 } }, async (chaos) => {
      const { shopId, variantGids, productOf } = chaos.fixture;
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `ID-SKU-${i}` } }),
        ),
      );

      // Keyed by Handle.
      const byHandle = await importPrices(shopId, "By handle", lines("Handle,Variant Price\nchaos-shirt,10.00\nchaos-hat,12.00"), "USD", { dryRun: true });
      expect(byHandle.ready).toBe(0);
      expect(byHandle.unmatched.map((p) => p.reason)).toEqual([HANDLE_REFUSAL, HANDLE_REFUSAL]);

      // A whole product, by its id: two variants, one price.
      const product = productOf.get(variantGids[0])!;
      for (const [label, result] of [
        ["price", await importPrices(shopId, "By product", lines(`Variant ID,Variant Price\n${product},10.00`), "USD", { dryRun: true })],
        ["cost", await importCosts(shopId, lines(`gid,Variant Cost\n${product},4.00`), "USD", { dryRun: true })],
      ] as const) {
        expect(result.ready, `the ${label} import applied a product's row to one of its variants`).toBe(0);
        expect(result.ambiguous.map((p) => p.reason)).toEqual([expect.stringMatching(/This is a product, not a variant -- it covers 2 variants/)]);
      }

      // A Shopify product export, verbatim header, Handle first and no Variant ID.
      const header =
        "Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value," +
        "Variant SKU,Variant Grams,Variant Price,Variant Compare At Price,Variant Barcode,Cost per item,Status";
      const row = (i: number) => `chaos-product,Chaos,,Chaos,,,,TRUE,Size,S,ID-SKU-${i},0,${10 + i}.00,,,,active`;
      const exported = await importPrices(shopId, "Shopify export", lines([header, row(0), row(1)].join("\n")), "USD", { dryRun: true });
      expect(exported.unmatched).toEqual([]);
      expect(exported.ready).toBe(2);
    });
  });
});
