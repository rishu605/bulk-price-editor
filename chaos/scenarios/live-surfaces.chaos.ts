/**
 * What's live can be filtered to base prices, and names a market by its title (#722).
 *
 * The base surface's gid is "", the filter form drops an empty value from the URL, so
 * "Base price" submitted nothing and the page showed every surface. And a market read
 * `pricing_by_market.19853246698_1786915628`, in the filter and the Surface column, because
 * the page printed the mirror's `name`.
 *
 * Read through `reconcile` with the page's own URL parsing, against a mirror holding the
 * fixture's base prices and one market list named the way Shopify names it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { BASE_SURFACE, reconciliationFiltersFrom } from "../../app/lib/reporting/export-filters";
import { reconcile } from "../../app/services/reconciliation.server";
import { withChaos } from "../harness/scenario";

const EUROPE = "gid://shopify/PriceList/chaos-europe";
const GENERATED = "pricing_by_market.19853246698_1786915628";

describe("chaos: What's live's surfaces", () => {
  it("filters to base prices, and names a market by its title", async () => {
    await withChaos("live-surfaces", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      await prisma.priceListRecord.create({
        data: { shopId, priceListGid: EUROPE, name: GENERATED, catalogTitle: "Europe", currency: "EUR", surfaceKind: "MARKET" },
      });
      await prisma.priceSurfaceEntry.createMany({
        data: variantGids.flatMap((variantGid) => [
          { shopId, variantGid, surfaceKind: "BASE" as const, priceListGid: "", currency: "USD", livePrice: 1000n },
          { shopId, variantGid, surfaceKind: "MARKET" as const, priceListGid: EUROPE, currency: "EUR", livePrice: 900n },
        ]),
        skipDuplicates: true,
      });
      const read = (query: Record<string, string>) =>
        reconcile(shopId, domain, reconciliationFiltersFrom(new URLSearchParams(query)), 1, 100);

      // Every surface: base and market rows, the market under its title.
      const every = await read({});
      expect(new Set(every.rows.map((row) => row.surface))).toEqual(new Set(["Base price", "Europe"]));
      expect(every.surfaces).toEqual([
        { value: BASE_SURFACE, name: "Base price", currency: "" },
        { value: EUROPE, name: "Europe", currency: "EUR" },
      ]);
      expect(JSON.stringify(every), "Shopify's generated name reached the page").not.toContain("pricing_by_market");

      // The Base price option, as the form submits it.
      const base = await read({ surface: BASE_SURFACE });
      expect(base.rows.length).toBe(variantGids.length);
      expect(base.rows.every((row) => row.priceListGid === "" && row.surface === "Base price")).toBe(true);

      // And the market's.
      const europe = await read({ surface: EUROPE });
      expect(europe.rows.map((row) => row.surface)).toEqual(variantGids.map(() => "Europe"));
    });
  });
});
