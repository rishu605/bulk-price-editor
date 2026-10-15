/**
 * One deleted variant does not take its product's other variants down with it (#1020).
 *
 * Without `allowPartialUpdates`, Shopify writes none of a call's variants if any one is
 * refused. The fake wrote the valid ones, so no scenario could see that in production one
 * variant deleted mid-run (E4) failed up to 250 of its product's. Both paths now ask for
 * partial updates, the fake refuses a call that does not, and a deleted variant is
 * skipped on the bulk path as on the sync path.
 */

import { describe, expect, it } from "vitest";

import { PRODUCT_VARIANTS_BULK_UPDATE } from "../../app/lib/execution/sync-executor";
import { ledgerOf, withChaos } from "../harness/scenario";

const CATALOG = { catalog: { products: 1, variantsPerProduct: 3 }, percent: -20 } as const;

describe("chaos: one variant deleted while its product is written", () => {
  it.each(["sync", "bulk"] as const)("skips that one and verifies the rest, on the %s path", async (path) => {
    await withChaos(`partial-updates-${path}`, CATALOG, async (chaos) => {
      const { variantGids } = chaos.fixture;
      const [gone, ...kept] = variantGids;
      chaos.fake.variants.get(gone)!.deleted = true;

      const outcome = await chaos.apply({ forcePath: path });
      const rows = await ledgerOf(outcome.runId);
      expect(rows.find((row) => row.variantGid === gone)?.status, "a deleted variant was reported as a failure").toBe("SKIPPED");
      for (const gid of kept) {
        expect(rows.find((row) => row.variantGid === gid)?.status, "the deleted one took its siblings down").toBe("VERIFIED");
      }
    });
  });

  it("writes nothing for a call that does not ask for partial updates, as Shopify does", async () => {
    await withChaos("partial-updates-fake", CATALOG, async (chaos) => {
      const { variantGids, productOf } = chaos.fixture;
      const [gone, other] = variantGids;
      chaos.fake.variants.get(gone)!.deleted = true;
      const before = chaos.fake.priceOf(other);

      const withoutFlag = PRODUCT_VARIANTS_BULK_UPDATE.replace(", allowPartialUpdates: true", "");
      expect(withoutFlag, "the app's own mutation no longer asks for partial updates").not.toContain("allowPartialUpdates");
      const answer = (await chaos.fake.request(withoutFlag, {
        productId: productOf.get(other),
        variants: [{ id: gone, price: "1.00" }, { id: other, price: "1.00" }],
      })) as { data: { productVariantsBulkUpdate: { userErrors: unknown[] } } };

      expect(answer.data.productVariantsBulkUpdate.userErrors).toHaveLength(1);
      expect(chaos.fake.priceOf(other), "a refused call wrote its valid variants").toBe(before);
    });
  });
});
