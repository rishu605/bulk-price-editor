/**
 * Read-back on the sync path, past Shopify's 250-id input limit (#698).
 *
 * The sync path takes campaigns up to 1,000 rows and reads every written price back.
 * It did that in one `nodes(ids:)` call, and Shopify refuses any input array over 250:
 * every campaign of 251 to 1,000 variants wrote all its prices correctly and then ended
 * PARTIAL with not one row verified. The fake now enforces the same limit, so the suite
 * can see it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { selectWritePath } from "../../app/lib/planning/write-path";
import { withChaos } from "../harness/scenario";

describe("chaos: reading back more than 250 written prices", () => {
  it("applies a 300-variant campaign on the sync path and ends verified-clean", async () => {
    await withChaos(
      "read-back-batch",
      { catalog: { products: 300, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { variantGids } = chaos.fixture;
        // The size that matters: over the input cap, under the bulk threshold.
        expect(selectWritePath(variantGids.length).path).toBe("sync");

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(applied.verified).toBe(variantGids.length);
        expect(applied.unverified).toBe(0);
        expect(applied.clean).toBe(true);

        const unverified = await prisma.variantChange.count({
          where: { runId: applied.runId, status: { not: "VERIFIED" } },
        });
        expect(unverified).toBe(0);
      },
    );
  });

  it("the fake refuses more than 250 ids, as Shopify does", async () => {
    await withChaos(
      "read-back-batch-fake",
      { catalog: { products: 1, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const ids = Array.from({ length: 251 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
        const response = (await chaos.fake.request(
          "query V($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price } } }",
          { ids },
        )) as { errors?: Array<{ message: string }> };
        expect(response.errors?.[0]?.message).toMatch(/greater than the maximum allowed of 250/);
      },
    );
  });
});
