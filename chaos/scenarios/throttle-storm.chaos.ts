/**
 * A 429 storm for the whole run (edge case E17).
 *
 * The assertion is deliberately not "the run was fast". It is that sustained
 * throttling makes the run *slow* and still *correct* -- because the tempting failure
 * here is the opposite of the usual one. Under contention it is easy to give up and
 * report a failure the merchant then has to reason about, when the right behaviour is
 * to back off, wait, and finish.
 *
 * The storm strikes every other request, not the first N. Consecutive failures would
 * burn one row's retry budget and prove nothing; alternating hits every write, lets
 * every retry through, and forces the run to absorb the delay.
 */

import { describe, expect, it } from "vitest";

import { isVariantWrite } from "../harness/faults";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a 429 storm through the whole run", () => {
  it("slows down, completes, and never reports an error", async () => {
    await withChaos(
      "throttle-storm",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -15 },
      async (chaos) => {
        chaos.arm([{ fault: "throttled", match: isVariantWrite, everyNth: 2 }]);

        const started = Date.now();
        const outcome = await chaos.apply();
        const elapsed = Date.now() - started;

        const verdict = await chaos.expectHonest(outcome.runId);
        expect(verdict.outcome).toBe("clean");

        // The storm has to have actually happened, or the scenario is asserting
        // nothing at all.
        const throttles = chaos.server.faults.count("throttled");
        expect(throttles).toBeGreaterThan(0);

        // Every row landed despite it. This is the claim: throttling delays a run, it
        // does not damage one.
        expect(outcome.failed).toBe(0);
        expect(outcome.clean).toBe(true);
        const rows = await ledgerOf(outcome.runId);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);

        // And it genuinely backed off rather than hammering. A lower bound only --
        // jitter puts the minimum sleep at half the base delay, so this cannot flake
        // upward on a slow machine.
        expect(elapsed).toBeGreaterThanOrEqual(throttles * 400);

        for (const row of rows) {
          const expected = Math.round(chaos.fixture.baseline.get(row.variantGid)! * 0.85);
          expect(chaos.fake.priceOf(row.variantGid)).toBe((expected / 100).toFixed(2));
        }
      },
    );
  });
});
