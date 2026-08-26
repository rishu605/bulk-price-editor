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

  it("puts back the ladder the catalogue had, and clears one it never had", async () => {
    await withChaos(
      "b2b-quantity-revert",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { applyQuantityBreaks, revertQuantityBreaks } = await import(
          "../../app/services/campaigns/b2b-surfaces.server"
        );

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

        // One variant already has the merchant's own ladder; the other has none. Revert
        // has to reach both end states, and they are different end states.
        const [withLadder, withoutLadder] = variantGids;
        chaos.fake.ladders.set(`${LIST.priceListGid}|${withLadder}`, [
          { minimumQuantity: 1, amount: "50.00" },
          { minimumQuantity: 24, amount: "45.00" },
        ]);

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");
        const client = chaosAdminClient(chaos.server.endpoint());

        // Capture baselines the way a real run does, so the ladder above becomes the
        // baseline rather than something this test asserts into place.
        await prisma.baseline.createMany({
          data: [
            {
              shopId,
              variantGid: withLadder!,
              surfaceKind: "MARKET" as const,
              priceListGid: LIST.priceListGid,
              currency: LIST.currency,
              basePrice: 5000n,
              quantityBreaks: [
                { minimumQuantity: 1, amount: 5000 },
                { minimumQuantity: 24, amount: 4500 },
              ],
              source: "AUTO_ENROLL" as const,
            },
            {
              shopId,
              variantGid: withoutLadder!,
              surfaceKind: "MARKET" as const,
              priceListGid: LIST.priceListGid,
              currency: LIST.currency,
              basePrice: 4000n,
              source: "AUTO_ENROLL" as const,
            },
          ],
          skipDuplicates: true,
        });

        const applied = await applyQuantityBreaks(
          shopId,
          runId,
          LIST,
          catalogue(variantGids),
          TIERS,
          { minMarginPercent: 20, missingCost: "refuse" },
          client,
        );
        expect(applied!.clean).toBe(true);

        await chaos.revert();
        const revertRunId = await chaos.latestRunId("REVERT");

        const outcome = await revertQuantityBreaks(shopId, revertRunId, LIST, variantGids, client);

        expect(outcome!.clean).toBe(true);
        expect(outcome!.messages.join(" ")).toMatch(/had no quantity breaks before/);

        // Recomputed, not restored — but for this variant the two agree, which is the
        // point: the baseline is the anchor and the anchor is the merchant's own ladder.
        expect(chaos.fake.ladders.get(`${LIST.priceListGid}|${withLadder}`)).toEqual([
          { minimumQuantity: 1, amount: "50.00" },
          { minimumQuantity: 24, amount: "45.00" },
        ]);

        // And the one that never had a ladder ends with none, rather than keeping the
        // campaign's — which would leave a buyer quoted a sale price forever.
        expect(chaos.fake.ladders.get(`${LIST.priceListGid}|${withoutLadder}`) ?? []).toEqual([]);
      },
    );
  });

  it("leaves alone a ladder this campaign never wrote", async () => {
    // A wholesale catalogue may carry ladders somebody set by hand. Reverting a campaign
    // takes away the campaign's, and taking away a ladder the merchant set themselves
    // would be this app deleting a price it never owned.
    await withChaos(
      "b2b-quantity-not-ours",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const { revertQuantityBreaks } = await import(
          "../../app/services/campaigns/b2b-surfaces.server"
        );

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

        const handSet = [{ minimumQuantity: 6, amount: "38.00" }];
        chaos.fake.ladders.set(`${LIST.priceListGid}|${variantGids[0]}`, handSet);

        await chaos.apply();
        await chaos.revert();
        const revertRunId = await chaos.latestRunId("REVERT");

        // No ledger row says this campaign gave that variant a ladder, so there is
        // nothing of ours to take back.
        const outcome = await revertQuantityBreaks(
          shopId,
          revertRunId,
          LIST,
          variantGids,
          chaosAdminClient(chaos.server.endpoint()),
        );

        expect(outcome).toBeNull();
        expect(chaos.fake.ladders.get(`${LIST.priceListGid}|${variantGids[0]}`)).toEqual(handSet);
      },
    );
  });
});
