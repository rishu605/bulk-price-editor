/**
 * The baseline history is named for the variant the merchant clicked, with its SKU (#753).
 *
 * Through the Baselines page's own loader.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }) },
}));

describe("chaos: a variant's baseline history", () => {
  it("is titled with the variant's name and SKU, not its gid", async () => {
    await withChaos("baseline-history-name", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { title: "Alpine Backpack 133 · S", sku: "AB-133-S" } });

      const { loader } = await import("../../app/routes/app.prices.baselines._index");
      const page = (await loader({
        request: new Request(`https://example.invalid/app/prices/baselines?variant=${encodeURIComponent(variantGids[0])}`),
        params: {},
        context: {},
      } as never)) as { historyTitle: string | null; history: unknown[] };
      expect(page.historyTitle).toBe("Alpine Backpack 133 · S (SKU AB-133-S)");
      expect(page.history.length, "the fixture's baseline is in its history").toBeGreaterThan(0);
    });
  });
});
