/**
 * A bulk run whose `bulk_operations/finish` webhook never arrives (edge case E13).
 *
 * Shopify documents that webhook as best-effort, and a run that waits for one that
 * never comes is the exact "frozen job" the category's one-star reviews describe. The
 * fallback is polling, and this proves the run reaches a verified end state without a
 * single webhook delivery.
 *
 * Worth being precise about what is under test: the engine has no `bulk_operations`
 * webhook consumer today, so polling is not merely the fallback -- it is the only
 * path. That makes this scenario a stronger proof of E13 than it would be otherwise,
 * and it is a standing reason not to make the webhook load-bearing later without
 * keeping this scenario green.
 *
 * The row count is above the bulk threshold on purpose. A scenario that forced the
 * path with a test-only flag would prove the bulk executor works when called, not
 * that a campaign of this size actually reaches it.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLD } from "../../app/lib/planning/write-path";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: the bulk finish webhook never arrives", () => {
  it("recovers by polling and verifies every row from the result file", async () => {
    await withChaos(
      "webhook-drop",
      {
        // Three variants per product, just over the threshold, so the planner picks
        // bulk on its own.
        catalog: { products: 340, variantsPerProduct: 3 },
        percent: -10,
        pollsBeforeComplete: 2,
      },
      async (chaos) => {
        expect(chaos.fixture.variantGids.length).toBeGreaterThan(DEFAULT_THRESHOLD);

        const outcome = await chaos.apply();
        const verdict = await chaos.expectHonest(outcome.runId);

        expect(verdict.outcome).toBe("clean");
        expect(outcome.clean).toBe(true);
        expect(outcome.failed).toBe(0);

        // The fallback did the work: the operation was not terminal on the first ask,
        // so the run had to keep polling to find out it had finished.
        expect(chaos.fake.polls).toBeGreaterThan(2);

        // Verified from the result file, not assumed. Absence is never success -- a
        // row the file never mentions must stay unverified, so a fully VERIFIED
        // ledger means every row was genuinely reported on.
        const rows = await ledgerOf(outcome.runId);
        expect(rows).toHaveLength(chaos.fixture.variantGids.length);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);

        for (const row of rows.slice(0, 25)) {
          const expected = Math.round(chaos.fixture.baseline.get(row.variantGid)! * 0.9);
          expect(chaos.fake.priceOf(row.variantGid)).toBe((expected / 100).toFixed(2));
        }
      },
    );
  });
});
