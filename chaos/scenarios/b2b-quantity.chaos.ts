/**
 * Wholesale ladders, written for real.
 *
 * The pure tests cover the arithmetic and the refusals. What only a database can show is
 * whether invariant I4 holds for a tiered price: a ledger row committed before the write,
 * carrying the whole ladder rather than just its first rung.
 *
 * The mutation is atomic per request, which makes the interesting failure a whole batch
 * rather than a row. A chunk that fails must leave every row in it recorded as failed —
 * including the ones Shopify never mentioned, because nothing in that batch was written.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";
import { chaosAdminClient } from "../harness/http-client";
import { money } from "../../app/lib/money/money";
import type { B2BVariantInput } from "../../app/services/campaigns/b2b-plan.server";

const TIERS = [
  { minimumQuantity: 1, discountBps: 0 },
  { minimumQuantity: 12, discountBps: 1000 },
];

const LIST = { priceListGid: "gid://shopify/PriceList/wholesale", name: "Wholesale", currency: "USD" };

function catalogue(variantGids: readonly string[]): B2BVariantInput[] {
  return variantGids.map((variantGid, index) => ({
    variantGid,
    title: `Product ${index}`,
    baseline: money(4000, "USD"),
    cost: money(1000, "USD"),
  }));
}

describe("chaos: wholesale quantity breaks", () => {
  it("commits a ledger row carrying the whole ladder before writing it", async () => {
    await withChaos(
      "b2b-quantity-apply",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { applyQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        chaos.fake.addPriceList({
          id: LIST.priceListGid,
          name: LIST.name,
          currency: LIST.currency,
          adjustment: null,
          catalog: {
            id: "gid://shopify/CompanyLocationCatalog/1",
            title: "Wholesale",
            __typename: "CompanyLocationCatalog",
          },
          prices: [],
        });

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");

        const outcome = await applyQuantityBreaks(
          shopId,
          runId,
          LIST,
          catalogue(variantGids),
          TIERS,
          { minMarginPercent: 20, missingCost: "refuse" },
          chaosAdminClient(chaos.server.endpoint()),
        );

        expect(outcome!.clean).toBe(true);
        expect(outcome!.verified).toBe(variantGids.length);

        // I4: the row exists, is verified, and carries every rung — not just the first.
        const ledgered = await prisma.variantChange.findMany({
          where: { runId, shopId, priceListGid: LIST.priceListGid },
          select: { status: true, intendedPrice: true, quantityBreaks: true, surfaceKind: true },
        });

        expect(ledgered).toHaveLength(variantGids.length);
        for (const row of ledgered) {
          expect(row.surfaceKind).toBe("B2B");
          expect(row.status).toBe("VERIFIED");
          expect(row.intendedPrice).toBe(4000n);
          expect(row.quantityBreaks).toEqual([
            { minimumQuantity: 1, amount: 4000 },
            { minimumQuantity: 12, amount: 3600 },
          ]);
        }
      },
    );
  });

  it("records every row of a rejected batch as failed, not just the named one", async () => {
    await withChaos(
      "b2b-quantity-atomic",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { applyQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        // No price list on the fake, so the mutation is refused outright — the closest
        // thing to "Shopify rejected the whole batch" the harness can produce honestly.
        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");

        const outcome = await applyQuantityBreaks(
          shopId,
          runId,
          LIST,
          catalogue(variantGids),
          TIERS,
          { minMarginPercent: 20, missingCost: "refuse" },
          chaosAdminClient(chaos.server.endpoint()),
        );

        expect(outcome!.clean).toBe(false);
        expect(outcome!.failed).toBe(variantGids.length);
        expect(outcome!.verified).toBe(0);

        const ledgered = await prisma.variantChange.findMany({
          where: { runId, shopId, priceListGid: LIST.priceListGid },
          select: { status: true, failureReason: true },
        });

        // Every one. A batch that applied nothing cannot have verified anything.
        expect(ledgered).toHaveLength(variantGids.length);
        expect(ledgered.every((row) => row.status === "FAILED")).toBe(true);
        expect(ledgered.every((row) => (row.failureReason ?? "").length > 0)).toBe(true);
      },
    );
  });

  it("prices nothing and says why when the wholesale floor cannot be checked", async () => {
    await withChaos(
      "b2b-quantity-no-cost",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { applyQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        const withoutCost = catalogue(variantGids).map((entry) => {
          const copy = { ...entry };
          delete copy.cost;
          return copy;
        });

        const outcome = await applyQuantityBreaks(
          shopId,
          await (async () => {
            await chaos.apply();
            return chaos.latestRunId("APPLY");
          })(),
          LIST,
          withoutCost,
          TIERS,
          { minMarginPercent: 20, missingCost: "refuse" },
          chaosAdminClient(chaos.server.endpoint()),
        );

        expect(outcome!.verified).toBe(0);
        expect(outcome!.refused).toBe(variantGids.length);
        expect(outcome!.messages.join(" ")).toMatch(/no cost is recorded/i);

        // Nothing ledgered, because nothing is going to be written. A PENDING row for a
        // price we already decided not to write would be a lie the reaper acts on.
        const ledgered = await prisma.variantChange.count({
          where: { shopId, priceListGid: LIST.priceListGid },
        });
        expect(ledgered).toBe(0);
      },
    );
  });
});
