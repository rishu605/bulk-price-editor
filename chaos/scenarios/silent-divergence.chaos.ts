/**
 * Shopify accepts the write, stores something else, and says nothing.
 *
 * No error, no throttle, no failure — the mutation succeeds and the storefront simply
 * shows a different price. A rounding rule, a currency setting, a price list that
 * reshapes the number: the merchant approved one price and shoppers pay another.
 *
 * A run that reports "verified clean" here is the single worst outcome this product can
 * produce, because the merchant has been told the opposite of the truth and has no reason
 * to look. Invariant I5 exists for exactly this, and it only holds if verification
 * compares prices rather than checking for errors.
 *
 * Both write paths are covered. The bulk path is the one that used to check only for
 * `userError`s, which meant the largest campaigns — the ones nobody can eyeball — had the
 * weakest guarantee.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/** A shop that rounds every stored price down to a whole unit. */
const roundsToWholeUnits = (requested: string) => `${Math.floor(Number(requested))}.00`;

describe("chaos: Shopify stores a price we did not ask for", () => {
  for (const path of ["sync", "bulk"] as const) {
    it(`refuses to call the run clean on the ${path} path`, async () => {
      await withChaos(
        `silent-divergence-${path}`,
        { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
        async (chaos) => {
          chaos.fake.distortStoredPrice = roundsToWholeUnits;

          const outcome = await chaos.apply({ forcePath: path });

          // The whole point: no row may be called verified when the store holds a
          // different number, however quietly it got there.
          expect(outcome.clean, "reported clean while the storefront disagreed").toBe(false);
          expect(outcome.verified).toBe(0);
          expect(outcome.failed).toBeGreaterThan(0);

          const runId = await chaos.latestRunId("APPLY");

          // The reason has to name both numbers, and the ledger has to carry the one the
          // store actually holds — in a column, not only in prose.
          const ledgered = await prisma.variantChange.findMany({
            where: { runId, shopId: chaos.fixture.shopId, status: "FAILED" },
            select: { failureReason: true, intendedPrice: true, appliedPrice: true },
          });

          expect(ledgered.length).toBeGreaterThan(0);
          for (const change of ledgered) {
            expect(change.failureReason, "the reason must say what happened")
              .toMatch(/Read-back mismatch/);
            expect(change.appliedPrice, "the observed price was not recorded").not.toBeNull();
            expect(change.appliedPrice).not.toBe(change.intendedPrice);
          }
        },
      );
    });
  }

  it("still verifies normally when the shop stores what it was asked for", async () => {
    // The control. Without it, a verification that failed everything would pass the
    // tests above and prove nothing.
    await withChaos(
      "silent-divergence-control",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const outcome = await chaos.apply();

        expect(outcome.clean).toBe(true);
        expect(outcome.verified).toBeGreaterThan(0);
        expect(outcome.failed).toBe(0);
      },
    );
  });
});
