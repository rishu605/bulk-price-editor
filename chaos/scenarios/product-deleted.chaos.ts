/**
 * A product deleted while the run is in flight (edge case E4).
 *
 * The failure this guards against is not losing the deleted row -- it is one poison
 * row taking the run down with it. A merchant tidying their catalogue during a sale
 * is ordinary behaviour, and a campaign that fails wholesale because of it is a
 * campaign nobody trusts to leave running.
 *
 * The row is SKIPPED rather than FAILED, which is a claim about honesty as much as
 * about mechanics: a run reporting failures nobody needs to act on is a run nobody
 * reads, and that is how a real failure goes unnoticed.
 */

import { describe, expect, it } from "vitest";

import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a product deleted mid-run", () => {
  it("skips the deleted row, writes every other one, and says so", async () => {
    await withChaos(
      "product-deleted",
      { catalog: { products: 6, variantsPerProduct: 2 }, percent: -20 },
      async (chaos) => {
        // Gone from Shopify, still in our mirror -- the `products/delete` webhook has
        // not landed yet. That gap is the whole scenario; a deletion we already knew
        // about would never have been planned.
        const victim = chaos.fixture.variantGids[0];
        chaos.fake.deleteVariant(victim);

        const outcome = await chaos.apply();
        await chaos.expectHonest(outcome.runId);

        const rows = await ledgerOf(outcome.runId);
        const deleted = rows.find((row) => row.variantGid === victim);

        expect(deleted?.status).toBe("SKIPPED");
        expect(deleted?.failureReason).toMatch(/no longer exists/i);

        // The point of the scenario: everything else still landed.
        const others = rows.filter((row) => row.variantGid !== victim);
        expect(others).not.toHaveLength(0);
        expect(others.every((row) => row.status === "VERIFIED")).toBe(true);

        for (const row of others) {
          const expected = Math.round(chaos.fixture.baseline.get(row.variantGid)! * 0.8);
          expect(Number(row.intendedPrice)).toBe(expected);
          expect(chaos.fake.priceOf(row.variantGid)).toBe((expected / 100).toFixed(2));
        }

        // Nothing was written for the variant that no longer exists.
        expect(chaos.fake.writeLog.some((write) => write.variantGid === victim)).toBe(false);
      },
    );
  });
});
