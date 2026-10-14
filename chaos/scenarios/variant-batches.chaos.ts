/**
 * One product with more variants in scope than Shopify takes in one write (#847).
 *
 * The sync path groups rows by product and sends each product in one
 * `productVariantsBulkUpdate`. Shopify refuses any input array over 250, and a product can
 * have 2,048 variants -- so a campaign pricing 600 of them, under the bulk threshold and
 * therefore all sync, sent a 600-element array, had it refused whole, and failed every row
 * of that product. Resume sent the same array and failed the same way. The fake now
 * enforces the cap on writes as it already did on read-back (#698), so the suite can see it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { selectWritePath } from "../../app/lib/planning/write-path";
import { isVariantWrite } from "../harness/faults";
import { ledgerOf, withChaos } from "../harness/scenario";

const VARIANTS = 600;

describe("chaos: one product with more variants in scope than one write takes", () => {
  it("prices all 600 on the sync path, never more than 250 a request, and ends verified-clean", async () => {
    await withChaos(
      "variant-batches",
      { catalog: { products: 1, variantsPerProduct: VARIANTS }, percent: -10 },
      async (chaos) => {
        const { variantGids, baseline } = chaos.fixture;
        // The size that matters: over the input cap, under the bulk threshold. Left to the
        // planner rather than forced, because this is the path a merchant's campaign takes.
        expect(selectWritePath(variantGids.length).path).toBe("sync");
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Every write went through `productVariantsBulkUpdate` -- the sync path -- and none
        // asked Shopify for more than it takes.
        const sizes = chaos.fake.variantWriteSizes;
        expect(sizes, "a write went over Shopify's 250-variant cap").toEqual([250, 250, 100]);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(250);

        expect(applied.verified).toBe(VARIANTS);
        expect(applied.failed).toBe(0);
        expect(applied.unverified).toBe(0);
        expect(applied.clean).toBe(true);

        const outstanding = await prisma.variantChange.count({
          where: { runId: applied.runId, status: { not: "VERIFIED" } },
        });
        expect(outstanding).toBe(0);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
      },
    );
  });

  it("leaves a refused request's rows visibly partial, and Resume writes just those", async () => {
    await withChaos(
      "variant-batches-partial",
      { catalog: { products: 1, variantsPerProduct: 300 }, percent: -10 },
      async (chaos) => {
        const { variantGids, baseline, campaignId } = chaos.fixture;
        const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        // The product's first request is refused on the wire, before the store sees it.
        chaos.arm([{ fault: "server-error", match: isVariantWrite, times: 1 }]);
        const first = await chaos.apply();
        chaos.heal();
        await chaos.expectHonest(first.runId);

        // That request's 250 rows failed; the second request's 50 landed and verified. One
        // refused request does not take the rest of its product down with it.
        expect(first.clean).toBe(false);
        expect(first.failed).toBe(250);
        expect(first.verified).toBe(50);
        const ledger = await ledgerOf(first.runId);
        const failed = ledger.filter((row) => row.status === "FAILED");
        expect(failed).toHaveLength(250);
        for (const row of failed) expect(chaos.fake.priceOf(row.variantGid)).toBe(full(row.variantGid));
        expect(chaos.fake.variantWriteSizes, "the refused request never reached the store").toEqual([50]);

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        expect(campaign.status).toBe("PARTIAL");

        // ------------------------------------------------------------ resume
        const resumed = await chaos.apply({ resume: true });
        await chaos.expectHonest(resumed.runId);

        // Only what was outstanding, in a request Shopify takes -- the resume of an
        // oversized product used to send the same refused array again.
        expect(resumed.planned).toBe(250);
        expect(chaos.fake.variantWriteSizes.slice(1)).toEqual([250]);
        expect(resumed.clean).toBe(true);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
      },
    );
  });

  it("the fake refuses more than 250 variants in one write, and writes none of them", async () => {
    await withChaos(
      "variant-batches-fake",
      { catalog: { products: 1, variantsPerProduct: 251 }, percent: -10 },
      async (chaos) => {
        const { variantGids, productOf, baseline } = chaos.fixture;
        const response = (await chaos.fake.request(
          "mutation U($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } } }",
          { productId: productOf.get(variantGids[0]), variants: variantGids.map((id) => ({ id, price: "1.00" })) },
        )) as { errors?: Array<{ message: string }> };

        expect(response.errors?.[0]?.message).toMatch(/size of 251 is greater than the maximum allowed of 250/);
        // Refused whole: not the first 250 written and the last turned away.
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
      },
    );
  });
});
