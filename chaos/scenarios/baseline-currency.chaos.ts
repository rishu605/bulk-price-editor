/**
 * A baseline in another currency is refused, and one already stored is never priced (#734).
 *
 * The baseline import parsed a row in its own currency column and wrote it as the base
 * price, unconverted. On a USD shop `TEE-S,2500,,JPY` became a JPY 2,500 baseline on a
 * USD variant; candidates then took the baseline's currency for the surface too, so the
 * planner's currency backstop saw nothing wrong, and a 20%-off campaign wrote $2,000.00
 * on a $20 T-shirt.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { importBaselines } from "../../app/services/baseline-import.server";
import { withChaos } from "../harness/scenario";

async function* lines(...items: string[]) {
  for (const item of items) yield item;
}

describe("chaos: a baseline in another currency", () => {
  it("is refused by the import, naming both currencies, and nothing is written", async () => {
    await withChaos("baseline-currency-import", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;

      const result = await importBaselines(shopId, lines("sku,price,compare_at,currency", `${variantGids[0]},2500,,JPY`), "USD");

      expect(result.written).toBe(0);
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0].reason).toMatch(/in JPY, but base prices on this store are in USD/);
      const current = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: variantGids[0], supersededAt: null } });
      expect(Number(current.basePrice)).toBe(baseline.get(variantGids[0]));
      expect(current.currency).toBe("USD");
    });
  });

  it("already stored, is skipped by a run rather than written to the USD price", async () => {
    await withChaos("baseline-currency-run", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;
      const [yen, dollars] = variantGids;
      const livePrice = chaos.fake.priceOf(yen);

      // What the import wrote before it refused: the row's number, in the row's currency.
      await prisma.baseline.updateMany({
        where: { shopId, variantGid: yen, supersededAt: null },
        data: { basePrice: 2500n, currency: "JPY" },
      });

      const run = await chaos.apply();

      expect(chaos.fake.priceOf(yen), "a yen baseline was discounted and written as dollars").toBe(livePrice);
      // Left alone visibly: the run says why, in the merchant's terms.
      expect(run.messages.join(" ")).toMatch(/1 product was skipped: they have a baseline in another currency than their price/);
      expect(await prisma.variantChange.count({ where: { runId: run.runId, variantGid: yen } })).toBe(0);
      // The rest of the campaign is unaffected.
      expect(chaos.fake.priceOf(dollars)).toBe((Math.round(baseline.get(dollars)! * 0.8) / 100).toFixed(2));
    });
  });
});
