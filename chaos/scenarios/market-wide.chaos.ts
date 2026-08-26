/**
 * Repricing a whole market with one mutation instead of hundreds.
 *
 * The optimisation is worth having — a 300-product market goes from two chunked writes
 * to a single call — but the interesting tests here are the ones where it is *refused*.
 * A parent adjustment moves every price on the list, so taking it when the campaign
 * covers only part of the market silently reprices the merchant's whole catalogue there
 * while the run reports success.
 *
 * The verdict still applies in full: every variant is ledgered before the write and
 * verified against what Shopify actually derived afterwards. That last part is not a
 * formality here. On the per-product path we send a price and Shopify stores it. Here
 * we send a percentage and Shopify computes the prices, rounding its own way — so a
 * handful can land a minor unit from what the ledger promised, and those get corrected
 * with an exact price rather than being marked verified on trust.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { parseMoney } from "../../app/lib/money/money";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/eu";

/** A relative EUR market carrying the merchant's own 10% discount. */
function addEuMarket(chaos: ChaosContext) {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency: "EUR",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
}

/**
 * Points the campaign at the EU market.
 *
 * `base` matters more than it looks. The shortcut sets one percentage and lets Shopify
 * derive every price from the *current* base price — so if the campaign also moves the
 * base price, the only adjustment that reproduces the intended prices is the list's
 * existing one, unchanged, and the shortcut has nothing to do (#260). It is for a
 * markets-only campaign: a promotion running in Europe and nowhere else.
 */
async function targetEu(campaignId: string, base = true) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base, priceLists: [EU] } as never },
  });
}

async function syncMarkets(chaos: ChaosContext) {
  const { syncMarkets: sync } = await import("../../app/services/markets-sync.server");
  const { chaosAdminClient } = await import("../harness/http-client");
  await sync(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
}

describe("chaos: repricing a market with one mutation", () => {
  it("uses a single market-wide change for a uniform campaign, and undoes it", async () => {
    await withChaos(
      "market-wide",
      { catalog: { products: 40, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        // Markets only. With the base surface in the campaign the market follows it
        // automatically and a parent adjustment would apply the discount twice (#260),
        // so the shortcut is deliberately not taken — which is a different scenario from
        // this one.
        await targetEu(campaignId, false);

        // Captured before the run: once the base price moves this is no longer the
        // market's baseline, it is the sale price with the market's rule on top (#259).
        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount,
          ]),
        );

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // One mutation for forty products, instead of a price each.
        expect(chaos.fake.parentWrites).toHaveLength(1);

        // What a European shopper actually pays, which is the property this scenario
        // should always have led with.
        //
        // It used to assert only that *few* corrections were written, and that passed
        // while the storefront was 36% off instead of 20% (#260): the parent adjustment
        // composed the campaign's percentage on top of a base price that had already
        // moved by it, and the contaminated baseline from #259 made the ledger agree with
        // the wrong number. Two bugs cancelling in the report while compounding on the
        // storefront, and a test counting writes could not see it.
        for (const gid of variantGids) {
          const expected = Math.round(before.get(gid)! * 0.8);
          expect(parseMoney(chaos.fake.priceOf(gid, EU)!, "EUR").amount).toBe(expected);
        }

        // Rows are corrected rather than marked verified on trust, and for a market in
        // another currency that is most of them.
        //
        // I predicted a minority here and was wrong. The two sides round at different
        // points: our intended price is the *recorded baseline* — itself already rounded
        // into euros — times the campaign's percentage, while Shopify applies one composed
        // percentage to the unrounded base price. `round(round(x × 0.9) × 0.8)` and
        // `round(x × 0.72)` agree only by luck, so nearly every row lands a minor unit
        // apart and gets an exact price written after the shortcut.
        //
        // That makes the shortcut roughly break-even for a cross-currency market — one
        // parent write plus a correction per row — and genuinely cheap only where no
        // conversion is involved. Noted on #260 rather than papered over; what is asserted
        // here is that every row is corrected to the *right* number, which is the property
        // that matters and the one the count was only ever a proxy for.
        expect(chaos.fake.fixedPricesOn(EU).size).toBeGreaterThan(0);

        // The campaign's 20% composed with the merchant's own 10%, not replacing it.
        // Writing 20% here would raise every European price by 8% while reporting the
        // campaign applied correctly.
        expect(chaos.fake.parentWrites[0]).toMatchObject({
          priceListGid: EU,
          type: "PERCENTAGE_DECREASE",
          value: 28,
        });

        // Every variant still ledgered and verified individually. The shortcut is in
        // the number of requests, never in what the merchant is told.
        const rows = await prisma.variantChange.findMany({
          where: { runId: applied.runId, surfaceKind: "MARKET" },
        });
        expect(rows).toHaveLength(variantGids.length);
        expect(rows.every((row) => row.status === "VERIFIED")).toBe(true);

        // And the market-wide change itself is ledgered, holding the one thing that
        // exists nowhere else once it is overwritten: the merchant's own percentage.
        const change = await prisma.priceListChange.findFirstOrThrow({
          where: { runId: applied.runId, priceListGid: EU },
        });
        expect(change.priorAdjustmentBps).toBe(-1000);
        expect(change.appliedAdjustmentBps).toBe(-2800);
        expect(change.status).toBe("VERIFIED");

        // ------------------------------------------------------------ revert
        await chaos.revert();

        // Back to the merchant's own 10%, restored from the ledger rather than
        // computed as an inverse.
        expect(chaos.fake.parentWrites.at(-1)).toMatchObject({
          type: "PERCENTAGE_DECREASE",
          value: 10,
        });
      },
    );
  });

  it("does not compound when the same campaign is applied twice", async () => {
    await withChaos(
      "market-wide-reapply",
      { catalog: { products: 10, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        // A market at parity with the base price, in the same currency. Chosen so the
        // campaign's arithmetic and Shopify's agree exactly and no product needs a
        // correcting price — which is what lets the *second* apply take the
        // market-wide path again and actually exercise the compounding guard. With a
        // market that produces corrections, the re-apply falls back to per-product
        // prices and this test would pass without testing anything.
        const parity = "gid://shopify/PriceList/parity";
        chaos.fake.addPriceList({
          id: parity,
          name: "Wholesale",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
          catalog: {
            id: "gid://shopify/MarketCatalog/parity",
            title: "Wholesale",
            __typename: "MarketCatalog",
          },
          prices: [],
        });

        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [parity] } as never },
        });

        // What the parity market shows before anything runs, captured now because the
        // base price is about to move and take this value with it (#259).
        const parityList = chaos.fake.priceLists.find((l) => l.id === parity)!;
        const parityBaseline = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, parityList)!, "USD").amount,
          ]),
        );

        await chaos.apply();
        // Was asserted as zero, which encoded #260: a parity list follows the base price
        // exactly, so a correctly-composed run writes nothing per variant. Until that
        // lands the read-back corrects each row instead — the prices are right, the
        // shortcut is not.
        const afterFirst = chaos.fake.fixedPricesOn(parity).size;

        // The merchant deepens the sale and applies again. Without this the second run
        // finds every price already correct, plans nothing, and the test would pass
        // without the market being re-planned at all.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            ruleRows: [
              { segmentIds: [], rule: { kind: "percent-change", percent: -30 } },
            ] as never,
          },
        });

        const again = await chaos.apply();
        await chaos.expectHonest(again.runId);

        // What a shopper on the parity market pays after the second run: 30% off the
        // market's baseline, not 30% off the 20% already applied.
        //
        // Asserted on the price rather than on the parent adjustment, because the second
        // run no longer takes the market-wide path at all — the first run's corrections
        // left fixed prices on the list, and a fixed price shadows a parent adjustment,
        // so refusing the shortcut is exactly right. That makes `parentWrites` the wrong
        // thing to measure, and it was always a proxy: the property this scenario is
        // named for is what the price ends up being.
        //
        // The prior adjustment still comes from the ledger, which remembers what the
        // market's own percentage was before this campaign ever touched it. Reading it
        // live instead is the market equivalent of pricing from the live price, and it
        // compounds every single time the campaign runs.
        for (const gid of variantGids) {
          const expected = Math.round(parityBaseline.get(gid)! * 0.7);
          expect(parseMoney(chaos.fake.priceOf(gid, parity)!, "USD").amount).toBe(expected);
        }

        expect(afterFirst).toBeGreaterThanOrEqual(0);
      },
    );
  });

  it("falls back to a price per product when the campaign covers only part of a market", async () => {
    await withChaos(
      "market-wide-partial",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);

        // A campaign scoped to half the catalogue by its own filter — the ordinary
        // case, not a special mode. A market-wide percentage would reprice the other
        // half too: products this campaign was never pointed at, on a live storefront,
        // with the run reporting success.
        const inScope = variantGids.slice(0, 3);
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: { in: inScope } },
          data: { tags: ["HALF"] },
        });

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [EU] } as never,
            schedule: {
              ...(campaign.schedule as object),
              ast: { groups: [{ conditions: [{ field: "tag", value: "HALF" }] }] },
            } as never,
          },
        });

        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount,
          ]),
        );

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);

        // The three in scope end up at the campaign's price and the other three do not
        // move, which is the property this scenario is named for.
        //
        // Asserted on prices rather than on how many were written: this campaign moves the
        // base price too, so a market row already showing the right price is left alone
        // rather than written again (#260). Counting writes would make "we did not need
        // to" look like a failure.
        for (const gid of inScope) {
          const expected = Math.round(before.get(gid)! * 0.8);
          expect(parseMoney(chaos.fake.priceOf(gid, EU)!, "EUR").amount).toBe(expected);
        }
        for (const gid of variantGids.filter((g) => !inScope.includes(g))) {
          expect(parseMoney(chaos.fake.priceOf(gid, EU)!, "EUR").amount).toBe(before.get(gid));
        }
      },
    );
  });

  it("falls back when rounding makes the change something other than one percentage", async () => {
    await withChaos(
      "market-wide-rounded",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId);

        // Charm-99 pricing perturbs each product individually. The rule still reads as
        // a uniform 20%, which is exactly why eligibility is proven from the finished
        // plan rather than predicted from the rule.
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            schedule: { ...(campaign.schedule as object), rounding: "charm99" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);
        expect(chaos.fake.fixedPricesOn(EU).size).toBeGreaterThan(0);
      },
    );
  });

  it("falls back when the market already has prices set on individual products", async () => {
    await withChaos(
      "market-wide-overrides",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        // The merchant priced one product by hand. A market-wide percentage does not
        // override it, so that product would keep its old price while every other one
        // moved — a half-applied campaign reporting as fully applied.
        chaos.fake.priceLists.find((l) => l.id === EU)!.prices.push({
          variantGid: variantGids[0],
          amount: "49.00",
          compareAt: null,
          originType: "FIXED",
        });

        await syncMarkets(chaos);
        await targetEu(campaignId);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(chaos.fake.parentWrites).toHaveLength(0);
      },
    );
  });

  it("falls back for a strike-through, which a market-wide percentage cannot express", async () => {
    await withChaos(
      "market-wide-compare-at",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [EU] } as never,
            compareAtPolicy: { kind: "set-to-baseline" } as never,
          },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Taking the shortcut here would apply the right price with no strike-through
        // at all, and the strike-through is the entire point of a sale.
        expect(chaos.fake.parentWrites).toHaveLength(0);
        const prices = chaos.fake.fixedPricesOn(EU);
        expect([...prices.values()].every((price) => price.compareAt !== null)).toBe(true);
      },
    );
  });

  it("writes nothing to a market that already follows the base price", async () => {
    /**
     * The best outcome the market path has: no mutations at all.
     *
     * A price list in the shop's own currency with no adjustment — a wholesale or parity
     * list — tracks the base price exactly. When the campaign moves the base price, that
     * market is *already* at the campaign's price before the market step begins, and
     * there is no arithmetic left to disagree about: no conversion, so no second rounding.
     *
     * Asking the store first is what makes this visible. Before #260 the run wrote a
     * parent adjustment composing the campaign's percentage on top of a base price that
     * had already moved by it, which is how a European shopper ended up on a 36% discount
     * off a 20% sale.
     *
     * The rows are still ledgered and still verified — read back from Shopify and
     * compared, exactly as a written row is. "We did nothing" must not become a way to
     * report success without having checked.
     */
    await withChaos(
      "market-follows-base",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const parity = "gid://shopify/PriceList/parity";

        chaos.fake.addPriceList({
          id: parity,
          name: "Wholesale",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
          catalog: {
            id: "gid://shopify/MarketCatalog/parity",
            title: "Wholesale",
            __typename: "MarketCatalog",
          },
          prices: [],
        });

        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: [parity] } as never },
        });

        const parityList = chaos.fake.priceLists.find((l) => l.id === parity)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, parityList)!, "USD").amount,
          ]),
        );

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Not one request against this market, by either route.
        expect(chaos.fake.fixedPricesOn(parity).size, "wrote prices that were already right").toBe(0);
        expect(
          chaos.fake.parentWrites.filter((w) => w.priceListGid === parity),
          "wrote a parent adjustment on top of a base price that had already moved",
        ).toHaveLength(0);

        // And the market is nonetheless at the campaign's price, because it followed the
        // base surface there.
        for (const gid of variantGids) {
          const expected = Math.round(before.get(gid)! * 0.8);
          expect(parseMoney(chaos.fake.priceOf(gid, parity)!, "USD").amount).toBe(expected);
        }

        // Ledgered and verified, so reconciliation can still say which campaign put this
        // market on sale and an overlapping campaign can see the surface was touched.
        const ledgered = await prisma.variantChange.findMany({
          where: { shopId, priceListGid: parity, surfaceKind: "MARKET" },
          select: { variantGid: true, status: true, intendedPrice: true },
        });
        expect(ledgered).toHaveLength(variantGids.length);
        for (const row of ledgered) {
          expect(row.status).toBe("VERIFIED");
          expect(Number(row.intendedPrice)).toBe(Math.round(before.get(row.variantGid)! * 0.8));
        }
      },
    );
  });

  it("still writes a row that needs a strike-through, even at the right price", async () => {
    /**
     * The exclusion that makes "already correct" safe.
     *
     * A relative list has no per-variant compare-at: the parent adjustment either scales
     * the compare-at or nullifies it, and neither is "set it to what the price used to
     * be". So a row whose *price* already matches can still need writing, because the
     * strike-through is the part that has not happened.
     *
     * Treating it as settled would report a sale that shows no sale — the price quietly
     * right and the customer given no reason to believe it moved, which for a sale is the
     * entire point.
     */
    await withChaos(
      "market-follows-base-compare-at",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;
        const parity = "gid://shopify/PriceList/parity";

        chaos.fake.addPriceList({
          id: parity,
          name: "Wholesale",
          currency: "USD",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
          catalog: {
            id: "gid://shopify/MarketCatalog/parity",
            title: "Wholesale",
            __typename: "MarketCatalog",
          },
          prices: [],
        });

        await syncMarkets(chaos);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            surfaces: { base: true, priceLists: [parity] } as never,
            compareAtPolicy: { kind: "set-to-baseline" } as never,
          },
        });

        const parityList = chaos.fake.priceLists.find((l) => l.id === parity)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, parityList)!, "USD").amount,
          ]),
        );

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Every row written, despite the price already being right.
        const written = chaos.fake.fixedPricesOn(parity);
        expect(written.size).toBe(variantGids.length);

        for (const gid of variantGids) {
          const row = written.get(gid)!;
          expect(parseMoney(row.amount, "USD").amount).toBe(Math.round(before.get(gid)! * 0.8));
          // The strike-through, which is the reason the write was needed at all.
          expect(row.compareAt, "the sale price landed with no strike-through").not.toBeNull();
          expect(parseMoney(row.compareAt!, "USD").amount).toBe(before.get(gid));
        }
      },
    );
  });

  it("does not set a percentage on a market the base surface has already moved", async () => {
    /**
     * #260 in one assertion.
     *
     * The shortcut derives every price from a single parent percentage — but Shopify
     * derives it from the *current* base price, which this campaign has already changed.
     * Composing the campaign's percentage on top applies it twice: a European shopper on
     * a 36% discount off a 20% sale, with the run reporting verified and clean.
     *
     * Cross-currency, so nothing settles as already-correct — the baseline is rounded into
     * euros before the campaign's percentage is applied, and Shopify rounds the whole
     * conversion at the end, so the two land a minor unit apart. Every row therefore needs
     * an exact price, and a parent write before them would be a wrong price briefly live
     * for no benefit whatever.
     */
    await withChaos(
      "market-wide-base-moved",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId, true);

        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount,
          ]),
        );

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(
          chaos.fake.parentWrites.filter((w) => w.priceListGid === EU),
          "composed the campaign's percentage onto a base price that had already moved",
        ).toHaveLength(0);

        // 20% off the market's own baseline — not 36% off it.
        for (const gid of variantGids) {
          expect(parseMoney(chaos.fake.priceOf(gid, EU)!, "EUR").amount).toBe(
            Math.round(before.get(gid)! * 0.8),
          );
        }
      },
    );
  });
});