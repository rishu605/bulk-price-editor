/**
 * A "Reduce by" campaign never raises a price (#740).
 *
 * With a margin floor and the default "clamp" policy, a variant whose cost sits close to
 * its price has a floor above its normal price. A 20%-off campaign clamped it to that
 * floor -- marking it *up* -- and counted it under "would change price" like any discount.
 * On the live store a 20% sale previewed jackets at $36,160.01. Now the row is left alone
 * and the run says why.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

describe("chaos: a discount over a floor above the normal price", () => {
  it("leaves that variant at its price, discounts the rest, and says why", async () => {
    await withChaos("discount-never-raises", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;
      const [thin, healthy] = variantGids;
      const thinPrice = chaos.fake.priceOf(thin);

      // A 40% minimum margin. The thin variant's cost is 5/6 of its price, so its floor is
      // cost ÷ 0.6 -- above the price it sells at today. The healthy one costs a tenth.
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      await prisma.shop.update({
        where: { id: shopId },
        data: { settings: { ...((shop.settings ?? {}) as object), minMarginPercent: 40, violationPolicy: "clamp" } as never },
      });
      for (const [gid, share] of [[thin, 5 / 6], [healthy, 0.1]] as const) {
        const cost = BigInt(Math.round(baseline.get(gid)! * share));
        await prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { cost } });
        await prisma.baseline.updateMany({ where: { shopId, variantGid: gid, supersededAt: null }, data: { cost } });
      }

      const run = await chaos.apply();

      expect(chaos.fake.priceOf(thin), "a 20%-off campaign raised a price to its floor").toBe(thinPrice);
      expect(run.messages.join(" ")).toMatch(/have a price floor above their normal price, and a discount never raises a price/);
      expect(chaos.fake.priceOf(healthy)).toBe((Math.round(baseline.get(healthy)! * 0.8) / 100).toFixed(2));
    });
  });
});
