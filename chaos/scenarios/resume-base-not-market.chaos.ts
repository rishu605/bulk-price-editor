/**
 * Resume retries a failed base price even when that variant's market price landed (#1037).
 *
 * The rows of the run being resumed were keyed by variant alone, and a campaign that prices
 * a market writes a row per surface for each variant. A landed market row could stand in for
 * the same variant's failed base row: the resume counted it as already verified, skipped
 * it, and could end clean with the base price never written.
 *
 * Through the real apply and Resume, with Shopify refusing one product's base write.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { ledgerOf, withChaos } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/resume-base-eu";

describe("chaos: resuming a run whose base write failed where its market write landed", () => {
  it("writes the base price on resume", async () => {
    await withChaos("resume-base-not-market", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      const [failing] = variantGids;
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/resume-base-eu", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [EUR] } as never } });

      // Shopify refuses one product's base write, every time; its market write still lands.
      chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(failing) }]);
      const first = await chaos.apply();
      const firstRows = await ledgerOf(first.runId);
      expect(firstRows.find((r) => r.variantGid === failing && r.priceListGid === "")?.status, "the premise: the base write failed").toBe("FAILED");
      expect(firstRows.find((r) => r.variantGid === failing && r.priceListGid === EUR)?.status, "the premise: the market write landed").toBe("VERIFIED");

      chaos.heal();
      const resumed = await chaos.apply({ resume: true });
      const sale = (Math.round(baseline.get(failing)! * 0.8) / 100).toFixed(2);
      expect(chaos.fake.priceOf(failing), "the resume skipped the failed base price").toBe(sale);
      expect(resumed.clean).toBe(true);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
    });
  });
});
