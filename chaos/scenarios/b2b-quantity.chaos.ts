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
import { withChaos, type ChaosContext } from "../harness/scenario";
import { chaosAdminClient } from "../harness/http-client";
import { money } from "../../app/lib/money/money";
import type { B2BVariantInput } from "../../app/services/campaigns/b2b-plan.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";

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
              ladderRead: true,
              source: "AUTO_ENROLL" as const,
            },
            {
              shopId,
              variantGid: withoutLadder!,
              surfaceKind: "MARKET" as const,
              priceListGid: LIST.priceListGid,
              currency: LIST.currency,
              basePrice: 4000n,
              ladderRead: true,
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

        const outcome = await revertQuantityBreaks(shopId, revertRunId, LIST, variantGids, FLOOR, client);

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
          FLOOR,
          chaosAdminClient(chaos.server.endpoint()),
        );

        expect(outcome).toBeNull();
        expect(chaos.fake.ladders.get(`${LIST.priceListGid}|${variantGids[0]}`)).toEqual(handSet);
      },
    );
  });

  // "No baseline" is not "no ladder" (#704). The revert used to clear a ladder whose variant
  // had no baseline at all, which on a merchant's own tiers deletes them. With nothing to
  // recompute from, the campaign's ladder stays and the revert says so: visibly unfinished.
  it("leaves a ladder with no baseline to go back to, and says the revert is not finished", async () => {
    await withChaos(
      "b2b-quantity-unanchored",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const [unanchored, anchored] = variantGids as [string, string];
        const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");
        const client = chaosAdminClient(chaos.server.endpoint());
        chaos.fake.addPriceList(wholesaleList());

        await chaos.apply();
        await applyQuantityBreaks(shopId, await chaos.latestRunId("APPLY"), LIST, catalogue(variantGids), TIERS, FLOOR, client);
        await prisma.baseline.create({
          data: { shopId, variantGid: anchored, surfaceKind: "MARKET", priceListGid: LIST.priceListGid, currency: "USD", basePrice: 4_000n, ladderRead: true, source: "AUTO_ENROLL" },
        });

        await chaos.revert();
        const outcome = await revertQuantityBreaks(shopId, await chaos.latestRunId("REVERT"), LIST, variantGids, FLOOR, client);

        expect(ladderOn(chaos, unanchored), "a ladder with no baseline was cleared as if the merchant had none").toEqual([["1", "40.00"], ["12", "36.00"]]);
        expect(ladderOn(chaos, anchored)).toEqual([]);
        expect(outcome, "a revert that left a campaign's ladder in place called itself clean").toMatchObject({ clean: false, verified: 1, failed: 1 });
        expect(outcome!.messages.join(" ")).toMatch(/1 product still has this campaign's quantity breaks, because no baseline records the price there before it/);
      },
    );
  });

  // A catalogue over 5,000 prices (#704). The ladder read walked the whole list, 50 pages of
  // 100, so a price past the 5,000th had "no ladder" -- and the read asked Shopify for a
  // query costing about 4,400 points, which Shopify refuses outright. The capture is the
  // campaign's own, as it runs before a campaign first writes a catalogue.
  it("captures, verifies and puts back a ladder past the catalogue's 5,000th price", async () => {
    await withChaos(
      "b2b-quantity-5000",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const [withLadder, withoutLadder] = variantGids as [string, string];
        const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");
        const { marketBaselines } = await import("../../app/services/campaigns/market-plan.server");
        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const client = chaosAdminClient(chaos.server.endpoint());

        // 5,200 prices the list derives, then the two the merchant set by hand, then 100 more.
        const derived = (from: number, count: number) =>
          Array.from({ length: count }, (_, n) => ({
            variantGid: `gid://shopify/ProductVariant/elsewhere-${from + n}`,
            amount: "10.00",
            compareAt: null,
            originType: "RELATIVE" as const,
          }));
        chaos.fake.addPriceList({
          ...wholesaleList(),
          prices: [
            ...derived(0, 5_200),
            { variantGid: withLadder, amount: "50.00", compareAt: null, originType: "FIXED" as const },
            { variantGid: withoutLadder, amount: "40.00", compareAt: null, originType: "FIXED" as const },
            ...derived(5_200, 100),
          ],
        });
        chaos.fake.ladders.set(`${LIST.priceListGid}|${withLadder}`, MERCHANTS.map((rung) => ({ ...rung })));
        await prisma.variantIndex.updateMany({ where: { shopId }, data: { cost: 1_000n } });

        await syncMarkets(client, shopId);
        chaos.fake.ladderReads = 0;
        await marketBaselines(shopId, MARKET_LIST, [...variantGids], client);

        const captured = await prisma.baseline.findMany({
          where: { shopId, priceListGid: LIST.priceListGid, supersededAt: null },
          select: { variantGid: true, surfaceKind: true, basePrice: true, quantityBreaks: true },
          orderBy: { basePrice: "desc" },
        });
        expect(captured, "the campaign's capture did not record the ladder past the 5,000th price").toEqual([
          { variantGid: withLadder, surfaceKind: "MARKET", basePrice: 5_000n, quantityBreaks: [{ minimumQuantity: 1, amount: 5_000 }, { minimumQuantity: 24, amount: 4_500 }] },
          { variantGid: withoutLadder, surfaceKind: "MARKET", basePrice: 4_000n, quantityBreaks: null },
        ]);
        expect(chaos.fake.ladderReads, "two variants' ladders took more than one read of a 5,302-price list").toBe(1);

        await chaos.apply();
        const runId = await chaos.latestRunId("APPLY");
        const applied = await applyQuantityBreaks(shopId, runId, LIST, await inputsFor(shopId, variantGids), TIERS, FLOOR, client);
        // Read back past the 5,000th price: before, the read-back found nothing there.
        expect(applied, "the read-back did not find the ladders it wrote").toMatchObject({ clean: true, verified: 2 });
        expect(ladderOn(chaos, withLadder)).toEqual([["1", "50.00"], ["12", "45.00"]]);

        await chaos.revert();
        const reverted = await revertQuantityBreaks(shopId, await chaos.latestRunId("REVERT"), LIST, variantGids, FLOOR, client);

        expect(reverted!.clean).toBe(true);
        expect(ladderOn(chaos, withLadder), "the revert deleted the merchant's own ladder").toEqual([["1", "50.00"], ["24", "45.00"]]);
        expect(ladderOn(chaos, withoutLadder)).toEqual([]);
      },
    );
  });

  // Two tiered sales on one catalogue (#704). The revert wrote the baseline back whatever
  // else was running, so ending one sale wiped the other's ladders; and it took back every
  // ladder any campaign had written there, so ending the lower sale cleared the higher one's.
  // Revert is `resolve(without C)` (rule 6), as on every other surface.
  describe("with a second tiered sale on the catalogue", () => {
    it("hands the higher sale's ladders to the lower when it ends, and the merchant's back when that ends", async () => {
      await withChaos("b2b-quantity-two-sales", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const [a, b] = variantGids as [string, string];
        const { lower, higher, client, inputs, tierHigher } = await twoSales(chaos);
        const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        // The lower sale gave A its ladder before the higher one existed; it never wrote B.
        await applyQuantityBreaks(shopId, lower.runId, LIST, inputs.filter((input) => input.variantGid === a), TIERS, FLOOR, client);
        await tierHigher();
        await applyQuantityBreaks(shopId, higher.runId, LIST, inputs, SIX_FOR_20, FLOOR, client);
        expect(ladderOn(chaos, a)).toEqual([["1", "50.00"], ["6", "40.00"]]);

        const endHigher = await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
        const handed = await revertQuantityBreaks(shopId, endHigher.runId, LIST, variantGids, FLOOR, client);

        expect(handed!.clean).toBe(true);
        expect(ladderOn(chaos, a), "ending the higher sale did not hand A to the lower one").toEqual([["1", "50.00"], ["12", "45.00"]]);
        expect(ladderOn(chaos, b), "ending the higher sale did not hand B to the lower one").toEqual([["1", "40.00"], ["12", "36.00"]]);
        expect(handed!.messages.join(" ")).toMatch(/2 products now have the quantity breaks of the next campaign/);

        // B is the lower sale's now, though no run of the lower sale's wrote it.
        await chaos.revert();
        const ended = await revertQuantityBreaks(shopId, await chaos.latestRunId("REVERT"), LIST, variantGids, FLOOR, client);

        expect(ended!.clean).toBe(true);
        expect(ladderOn(chaos, a), "the merchant's own ladder did not come back").toEqual([["1", "50.00"], ["24", "45.00"]]);
        expect(ladderOn(chaos, b), "the ladder the lower sale was handed outlived it").toEqual([]);
      });
    });

    it("leaves the higher sale's ladders alone when the lower one ends", async () => {
      await withChaos("b2b-quantity-lower-ends", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const [a, b] = variantGids as [string, string];
        const { lower, higher, client, inputs, tierHigher } = await twoSales(chaos);
        const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        // As above: A was the lower sale's before the higher one was a tiered sale.
        await applyQuantityBreaks(shopId, lower.runId, LIST, inputs.filter((input) => input.variantGid === a), TIERS, FLOOR, client);
        await tierHigher();
        await applyQuantityBreaks(shopId, higher.runId, LIST, inputs, SIX_FOR_20, FLOOR, client);

        await chaos.revert();
        const revertRunId = await chaos.latestRunId("REVERT");
        const outcome = await revertQuantityBreaks(shopId, revertRunId, LIST, variantGids, FLOOR, client);

        expect(outcome!.clean).toBe(true);
        // A was the lower sale's to take back, and the higher sale still prices it.
        expect(ladderOn(chaos, a), "ending the lower sale took the higher one's ladder off A").toEqual([["1", "50.00"], ["6", "40.00"]]);
        expect(ladderOn(chaos, b), "ending the lower sale cleared a ladder only the higher one wrote").toEqual([["1", "40.00"], ["6", "32.00"]]);
        expect(
          await prisma.variantChange.count({ where: { runId: revertRunId, variantGid: b, surfaceKind: "B2B" } }),
          "the lower sale's revert wrote a ladder it never held",
        ).toBe(0);
      });
    });

    // Apply is the other half of rule 4 (#1104). It planned its own tiers alone, so the
    // lower sale applied after the higher one wrote its ladder over the higher one's, and
    // a buyer was quoted the lower sale while the higher ran.
    it("leaves the higher sale's ladders in place when the lower one is applied after it", async () => {
      await withChaos("b2b-quantity-lower-after", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;
        const [a, b] = variantGids as [string, string];
        const { lower, higher, client, inputs, tierHigher } = await twoSales(chaos);
        const { applyQuantityBreaks, revertQuantityBreaks } = await import("../../app/services/campaigns/b2b-surfaces.server");

        await tierHigher();
        await applyQuantityBreaks(shopId, higher.runId, LIST, inputs, SIX_FOR_20, FLOOR, client);
        const applied = await applyQuantityBreaks(shopId, lower.runId, LIST, inputs, TIERS, FLOOR, client);

        expect(applied!.clean).toBe(true);
        expect(ladderOn(chaos, a), "applying the lower sale wrote its ladder over the higher one's on A").toEqual([["1", "50.00"], ["6", "40.00"]]);
        expect(ladderOn(chaos, b), "applying the lower sale wrote its ladder over the higher one's on B").toEqual([["1", "40.00"], ["6", "32.00"]]);
        expect(
          await prisma.variantChange.count({ where: { runId: lower.runId, surfaceKind: "B2B" } }),
          "the lower sale ledgered a ladder it did not write",
        ).toBe(0);
        expect(applied!.messages.join(" ")).toMatch(/2 products keep "chaos\/higher-wholesale-sale"'s quantity breaks/);

        // Ending the higher sale then hands both to the lower one, as before.
        const endHigher = await runCampaign(shopId, higher.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
        await revertQuantityBreaks(shopId, endHigher.runId, LIST, variantGids, FLOOR, client);
        expect(ladderOn(chaos, a)).toEqual([["1", "50.00"], ["12", "45.00"]]);
        expect(ladderOn(chaos, b)).toEqual([["1", "40.00"], ["12", "36.00"]]);
      });
    });
  });
});

/** The wholesale floor every apply and revert here is held to: 20% over a $10.00 cost. */
const FLOOR = { minMarginPercent: 20, missingCost: "refuse" as const };

/** 1+ at full price, 6+ at 20% off: the higher sale's ladder. */
const SIX_FOR_20 = [
  { minimumQuantity: 1, discountBps: 0 },
  { minimumQuantity: 6, discountBps: 2000 },
];

/** The merchant's own ladder on the first variant: $50.00, and $45.00 for 24 or more. */
const MERCHANTS = [
  { minimumQuantity: 1, amount: "50.00" },
  { minimumQuantity: 24, amount: "45.00" },
];

/** LIST as the campaign's market planner names it: a company-location catalogue, no country. */
const MARKET_LIST = { ...LIST, adjustmentBps: null, contextCountry: null };

function wholesaleList() {
  return {
    id: LIST.priceListGid,
    name: LIST.name,
    currency: LIST.currency,
    adjustment: null,
    catalog: { id: "gid://shopify/CompanyLocationCatalog/1", title: "Wholesale", __typename: "CompanyLocationCatalog" },
    prices: [],
  };
}

/** The ladder a variant has on the catalogue now, as `[minimum, amount]` pairs. */
function ladderOn(chaos: ChaosContext, variantGid: string): Array<[string, string]> {
  return (chaos.fake.ladders.get(`${LIST.priceListGid}|${variantGid}`) ?? [])
    .map((rung): [string, string] => [String(rung.minimumQuantity), rung.amount])
    .sort((x, y) => Number(x[0]) - Number(y[0]));
}

/** What a run hands the ladder writer: each variant's catalogue baseline and its cost. */
async function inputsFor(shopId: string, variantGids: readonly string[]): Promise<B2BVariantInput[]> {
  const baselines = await prisma.baseline.findMany({
    where: { shopId, priceListGid: LIST.priceListGid, surfaceKind: "MARKET", supersededAt: null, variantGid: { in: [...variantGids] } },
  });
  return baselines.map((row) => ({
    variantGid: row.variantGid,
    title: row.variantGid,
    baseline: money(Number(row.basePrice), row.currency),
    cost: money(1_000, row.currency),
  }));
}

/**
 * A wholesale catalogue with two tiered sales on it: the fixture's campaign at priority 100
 * with 12+ at 10% off, and a second at priority 200 with 6+ at 20% off. The first variant is
 * set by hand at $50.00 with the merchant's own ladder; the second at $40.00 with none.
 *
 * Both are applied as the run applies them, then given the catalogue: the ladder writer is
 * called here as the run will call it, and the run's own market path is not what these
 * scenarios test. The lower sale gets its tiers here; the higher one when the scenario calls
 * `tierHigher`, so a scenario can have the lower sale write before the higher one is a
 * tiered sale at all (#1104).
 */
async function twoSales(chaos: ChaosContext) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  const [a, b] = variantGids as [string, string];
  const client = chaosAdminClient(chaos.server.endpoint());

  chaos.fake.addPriceList({
    ...wholesaleList(),
    prices: [
      { variantGid: a, amount: "50.00", compareAt: null, originType: "FIXED" as const },
      { variantGid: b, amount: "40.00", compareAt: null, originType: "FIXED" as const },
    ],
  });
  chaos.fake.ladders.set(`${LIST.priceListGid}|${a}`, MERCHANTS.map((rung) => ({ ...rung })));
  await prisma.variantIndex.updateMany({ where: { shopId }, data: { cost: 1_000n } });
  await prisma.baseline.createMany({
    data: [
      { shopId, variantGid: a, surfaceKind: "MARKET" as const, priceListGid: LIST.priceListGid, currency: "USD", basePrice: 5_000n, handSet: true, ladderRead: true, source: "AUTO_ENROLL" as const, quantityBreaks: [{ minimumQuantity: 1, amount: 5_000 }, { minimumQuantity: 24, amount: 4_500 }] },
      { shopId, variantGid: b, surfaceKind: "MARKET" as const, priceListGid: LIST.priceListGid, currency: "USD", basePrice: 4_000n, handSet: true, ladderRead: true, source: "AUTO_ENROLL" as const },
    ],
  });

  await prisma.campaign.update({ where: { id: campaignId }, data: { priority: 100 } });
  await chaos.apply();
  const lowerRun = await chaos.latestRunId("APPLY");

  const second = await createCampaign(shopId, {
    name: "chaos/higher-wholesale-sale",
    priority: 200,
    rule: { kind: "percent-change", percent: -30 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
    schedule: { kind: "manual" },
  } as never);
  const higherRun = (await runCampaign(shopId, second.id, client, { actor: "chaos", verifySampleRate: 1 })).runId;

  await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [LIST.priceListGid], quantityTiers: TIERS } as never } });

  return {
    client,
    tierHigher: async () => {
      await prisma.campaign.update({ where: { id: second.id }, data: { surfaces: { base: true, priceLists: [LIST.priceListGid], quantityTiers: SIX_FOR_20 } as never } });
    },
    inputs: await inputsFor(shopId, variantGids),
    lower: { id: campaignId, runId: lowerRun },
    higher: { id: second.id, runId: higherRun },
  };
}
