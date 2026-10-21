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
 * with an exact price rather than being marked verified on trust. So does every price it
 * reports in a currency other than the market's, which on a percentage list in another
 * currency is all of them (#257): see the first scenario.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { describeCorrections } from "../../app/lib/markets/uniform";
import { parseMoney } from "../../app/lib/money/money";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/eu";

/** A relative EUR market carrying the merchant's own 10% discount. */
function addEuMarket(chaos: ChaosContext) {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency: "EUR",
    country: "DE",
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
 * markets-only campaign: a promotion running in Europe and nowhere else, which leaves the
 * base price where it is (#1094).
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

/**
 * Every variant's base price as the store holds it, and how many base-price rows the shop's
 * runs ledgered. A campaign on Europe alone changes neither (#1094): it used to reprice the
 * base price for every shopper, 97.00 to 77.60, and the shortcut then took its 20% again.
 */
async function baseOf(chaos: ChaosContext) {
  return {
    prices: new Map(chaos.fixture.variantGids.map((gid) => [gid, chaos.fake.priceOf(gid)])),
    rows: await prisma.variantChange.count({ where: { shopId: chaos.fixture.shopId, surfaceKind: "BASE" } }),
  };
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

        // Captured before the run: once the market's percentage moves this is no longer
        // the market's baseline, it is the sale price (#259).
        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const before = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount,
          ]),
        );
        const base = await baseOf(chaos);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // A sale for Europe, and nowhere else: the price every other shopper pays is where
        // it was, and no run planned or ledgered one (#1094).
        expect(await baseOf(chaos), "a markets-only campaign moved the base price").toEqual(base);

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

        // Rows are corrected rather than marked verified on trust: for a market in another
        // currency, every one of them, and not because of rounding.
        //
        // This said rounding was why, and so did the run, in a sentence to the merchant.
        // Rounding does put some rows a minor unit apart -- our price rounds the recorded
        // baseline into euros before the campaign's percentage, Shopify rounds one composed
        // percentage at the end, and `round(round(x × 0.9) × 0.8)` and `round(x × 0.72)` agree
        // only by luck -- but it is not what makes every row need one. A list priced by a
        // percentage answers in the shop's currency (#257), so the read-back has no euro
        // price to check any row against. And until #1094 the corrections hid something
        // worse: the run moved the base price too, so the percentage derived every euro price
        // from a base already 20% off, 0.8 × 0.72 of it, until each row was pinned.
        //
        // So what is asserted is the thing the corrections cannot hide: the percentage itself
        // lands within a cent of every price the ledger promised, composed onto a base price
        // that did not move. And the run names the cause it had.
        const corrected = chaos.fake.fixedPricesOn(EU);
        expect(corrected.size).toBe(variantGids.length);
        for (const gid of variantGids) {
          const derived = parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount;
          expect(
            Math.abs(derived - Math.round(before.get(gid)! * 0.8)),
            `${gid}: the percentage alone does not give the campaign's price`,
          ).toBeLessThanOrEqual(1);
        }
        expect(applied.messages).toContain(describeCorrections("Europe", { unchecked: variantGids.length })[0]);
        expect(applied.messages.join(" "), "named rounding as the cause").not.toContain("rounded");

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
        // And nothing to put back on the base price, because nothing moved it.
        expect(await baseOf(chaos), "the revert wrote a base price").toEqual(base);
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
          country: "US",
          adjustment: { type: "PERCENTAGE_DECREASE", value: 0 },
          catalog: {
            id: "gid://shopify/MarketCatalog/parity",
            title: "Wholesale",
            __typename: "MarketCatalog",
          },
          prices: [],
        });

        await syncMarkets(chaos);
        // Markets only, so the shortcut is the path taken at all. Until #1094 this was the
        // base surface too, and that never takes the shortcut: the market follows the base
        // price there and is already right (`writes nothing to a market that already follows
        // the base price`, below). A markets-only campaign used to move the base price as
        // well, and then the shortcut doubled the discount and every row was corrected. Now
        // the base price stays put, and a parity list needs no correction at all.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: false, priceLists: [parity] } as never },
        });

        // What the parity market shows before anything runs, captured now because the
        // market's percentage is about to move and take this value with it (#259).
        const parityList = chaos.fake.priceLists.find((l) => l.id === parity)!;
        const parityBaseline = new Map(
          variantGids.map((gid) => [
            gid,
            parseMoney(chaos.fake.derivedPriceOf(gid, parityList)!, "USD").amount,
          ]),
        );
        const base = await baseOf(chaos);

        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);
        // One percentage, and not one exact price after it: the same currency, so nothing to
        // round twice. Was asserted as zero once, then relaxed to "zero or more" while the
        // double discount made every row need one (#260, #1094).
        expect(chaos.fake.parentWrites.filter((w) => w.priceListGid === parity)).toEqual([
          { priceListGid: parity, type: "PERCENTAGE_DECREASE", value: 20 },
        ]);
        expect(chaos.fake.fixedPricesOn(parity).size, "a same-currency market needed exact prices").toBe(0);
        expect(first.messages.join(" ")).not.toContain("needed an exact price");

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

        // And a sync in between, as the store's own webhooks bring one: the mirror now says
        // the list is 20% off. That is the campaign's percentage, not the merchant's, and a
        // baseline read again "at today's setting" (#1093) would be the sale price -- 30% off
        // it is 44% off the market's regular price (#1094).
        await syncMarkets(chaos);

        const again = await chaos.apply();
        await chaos.expectHonest(again.runId);

        // What a shopper on the parity market pays after the second run: 30% off the
        // market's baseline, not 30% off the 20% already applied.
        for (const gid of variantGids) {
          const expected = Math.round(parityBaseline.get(gid)! * 0.7);
          expect(parseMoney(chaos.fake.priceOf(gid, parity)!, "USD").amount).toBe(expected);
        }

        // And by the shortcut again, which is the guard this scenario is named for. With
        // fixed prices left by a first run's corrections, the second refused the shortcut
        // and this was asserted on the price alone.
        //
        // The prior adjustment comes from the ledger, which remembers what the market's own
        // percentage was before this campaign ever touched it: 0%, so 30% is written, not the
        // 44% that composing with the campaign's own 20% would be. Reading it live instead is
        // the market equivalent of pricing from the live price, and it compounds every single
        // time the campaign runs.
        expect(chaos.fake.parentWrites.filter((w) => w.priceListGid === parity).at(-1), "the second run compounded").toEqual({
          priceListGid: parity,
          type: "PERCENTAGE_DECREASE",
          value: 30,
        });
        const change = await prisma.priceListChange.findFirstOrThrow({ where: { runId: again.runId, priceListGid: parity } });
        expect(change.priorAdjustmentBps).toBe(0);
        expect(chaos.fake.fixedPricesOn(parity).size).toBe(0);

        expect(await baseOf(chaos), "a markets-only campaign moved the base price").toEqual(base);
      },
    );
  });

  it("re-applied after a revert, composes with and puts back the market's setting as it is now (#705)", async () => {
    /**
     * A recurring sale on a market priced by a percentage, and a merchant who changed that
     * percentage between two months of it.
     *
     * The campaign remembers the market's own percentage so its revert can put it back,
     * and it remembered the first one it ever saw. That is right within one application --
     * a second run's "before" is the campaign's own percentage -- and wrong across a revert,
     * after which the market is the merchant's again and they may move it. Month two then
     * composed with last month's 10% instead of today's 15%, and its revert wrote 10% over
     * the merchant's 15%: their own setting, lost to a sale that had ended.
     */
    await withChaos(
      "market-wide-reapply-after-revert",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId, variantGids } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId, false);
        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const base = await baseOf(chaos);

        // ------------------------------------------------------------ month one
        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);
        // The campaign's 20% composed with the market's 10%, onto a base price it left
        // alone (#1094): logging the base price around these runs is how that was found.
        expect(chaos.fake.parentWrites.at(-1)).toMatchObject({
          priceListGid: EU,
          type: "PERCENTAGE_DECREASE",
          value: 28,
        });
        expect(await baseOf(chaos), "month one moved the base price").toEqual(base);

        const firstRevert = await chaos.revert();
        await chaos.expectHonest(firstRevert.runId);
        expect(euList.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });

        // ------------------------------------------- the merchant's own change
        // Made in Shopify, between the two months, with no campaign on the market.
        euList.adjustment = { type: "PERCENTAGE_DECREASE", value: 15 };
        await syncMarkets(chaos);

        // ------------------------------------------------------------ month two
        const second = await chaos.apply();
        await chaos.expectHonest(second.runId);

        const writes = chaos.fake.parentWrites.filter((w) => w.priceListGid === EU);
        expect(writes, "month two did not take the market-wide path").toHaveLength(3);
        // composeBps(-1500, -2000): the campaign's 20% on the merchant's 15%, not on the
        // 10% the market had a month ago.
        expect(writes.at(-1), "composed with last month's market setting").toMatchObject({
          type: "PERCENTAGE_DECREASE",
          value: 32,
        });

        const change = await prisma.priceListChange.findFirstOrThrow({
          where: { runId: second.runId, priceListGid: EU },
        });
        expect(change.priorAdjustmentBps, "recorded last month's setting as the merchant's").toBe(-1500);
        expect(change.appliedAdjustmentBps).toBe(-3200);

        const secondRevert = await chaos.revert();
        await chaos.expectHonest(secondRevert.runId);

        // ------------------------------------------- the merchant's setting back
        expect(
          chaos.fake.parentWrites.filter((w) => w.priceListGid === EU).at(-1),
          "the revert wrote last month's setting over the merchant's own",
        ).toMatchObject({ type: "PERCENTAGE_DECREASE", value: 15 });
        expect(euList.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 15 });

        // And what a European shopper pays is the merchant's 15% again: no price left
        // pinned on the list, every one derived from their own setting.
        expect(chaos.fake.fixedPricesOn(EU).size).toBe(0);
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid, EU)).toBe(chaos.fake.derivedPriceOf(gid, euList));
        }
        // Two months on and off, and the base price never moved.
        expect(await baseOf(chaos)).toEqual(base);
      },
    );
  });

  it("keeps the merchant's setting from the sale's first write while it is on, and nothing from before the revert after it (#705)", async () => {
    /**
     * The edges of #705's rule.
     *
     * "Since the last revert" must not become "since the last write". Until the revert, the
     * list carries the campaign's own 28%, and a resumed or repeated market-wide write that
     * took that for the merchant's would compose 20% on top of it -- 42.4% off -- and its
     * revert would put the sale's 28% back as theirs.
     *
     * Nor "since the last row the revert settled". A write Shopify rejected during the sale
     * is never settled as reverted, and still carries the old setting after the revert.
     *
     * The second write is called directly because a run cannot reach it here: the first
     * write's corrections leave fixed prices on the list, and a fixed price refuses the
     * shortcut next time.
     */
    await withChaos(
      "market-wide-second-write-live",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;

        addEuMarket(chaos);
        await syncMarkets(chaos);
        await targetEu(campaignId, false);
        const euList = chaos.fake.priceLists.find((l) => l.id === EU)!;
        const base = await baseOf(chaos);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        expect(await baseOf(chaos), "a markets-only campaign moved the base price").toEqual(base);
        expect(chaos.fake.fixedPricesOn(EU).size, "no correction, so a run could reach the second write").toBeGreaterThan(0);

        const { applyMarketWide } = await import("../../app/services/campaigns/market-wide.server");
        const { readParentState } = await import("../../app/lib/execution/price-list-parent");
        const { chaosAdminClient } = await import("../harness/http-client");
        const client = chaosAdminClient(chaos.server.endpoint());

        // What the list says now is the campaign's percentage, not the merchant's.
        const parent = (await readParentState(client, EU))!;
        expect(parent.adjustmentBps).toBe(-2800);

        const again = await prisma.campaignRun.create({
          data: { shopId, campaignId, kind: "APPLY", occurrenceKey: "APPLY-705-again", status: "COMPLETED" },
        });
        await applyMarketWide({
          shopId,
          campaignId,
          runId: again.id,
          list: { priceListGid: EU, name: "Europe", currency: "EUR" },
          rows: [],
          campaignBps: -2000,
          parent,
          client,
        });

        const change = await prisma.priceListChange.findFirstOrThrow({
          where: { runId: again.id, priceListGid: EU },
        });
        expect(change.priorAdjustmentBps, "took the campaign's own percentage for the merchant's").toBe(-1000);
        expect(chaos.fake.parentWrites.at(-1)).toMatchObject({
          priceListGid: EU,
          type: "PERCENTAGE_DECREASE",
          value: 28,
        });

        // And one more during the sale that Shopify rejected, ledgered as `applyMarketWide`
        // ledgers a rejection. The revert leaves it FAILED, not REVERTED, so it is still
        // there once the market is the merchant's again -- older than the revert, and
        // carrying the 10% the merchant is about to change.
        const rejected = await prisma.campaignRun.create({
          data: { shopId, campaignId, kind: "APPLY", occurrenceKey: "APPLY-705-rejected", status: "PARTIAL" },
        });
        await prisma.priceListChange.create({
          data: {
            shopId,
            runId: rejected.id,
            campaignId,
            priceListGid: EU,
            priorAdjustmentBps: -1000,
            appliedAdjustmentBps: -2800,
            status: "FAILED",
            failureReason: "Shopify rejected the adjustment.",
          },
        });

        const reverted = await chaos.revert();
        await chaos.expectHonest(reverted.runId);
        expect(euList.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });

        // The merchant's own change, then the next month's sale: composed with today's 15%,
        // because everything this campaign wrote before the revert landed is history.
        euList.adjustment = { type: "PERCENTAGE_DECREASE", value: 15 };
        const next = await chaos.apply();
        await chaos.expectHonest(next.runId);

        const nextChange = await prisma.priceListChange.findFirstOrThrow({
          where: { runId: next.runId, priceListGid: EU },
        });
        expect(nextChange.priorAdjustmentBps, "a write from before the revert decided the prior").toBe(-1500);
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
          country: "US",
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
          country: "US",
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