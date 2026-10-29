/**
 * A campaign for its markets and not the base price never moves the base price (#1094).
 *
 * `surfaces.base: false` -- a sale for Europe and nowhere else -- was read in one place: the
 * market-wide shortcut took it to mean the base price had not moved. Nothing else read it. The
 * run planned, ledgered, wrote and reverted the base price as it does for any campaign, so
 * every shopper on the store got Europe's sale, and the shortcut then composed the campaign's
 * percentage onto a base price that had already moved by it -- #260's double discount -- until
 * the read-back pinned each euro price with an exact one.
 *
 * Dormant: `createCampaign` writes `base: true`, so each scenario turns it off directly, as the
 * market-wide ones do. Through the real apply, preview, revert, resume and one-variant revert.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { parseMoney } from "../../app/lib/money/money";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const EU = "gid://shopify/PriceList/markets-only-eu";

/** Europe, priced by the merchant's own 10% off the base price, and the campaign on it alone. */
async function europeOnly(chaos: ChaosContext, { currency = "EUR", percentOff = 10 } = {}) {
  chaos.fake.addPriceList({
    id: EU,
    name: "Europe",
    currency,
    country: "DE",
    adjustment: { type: "PERCENTAGE_DECREASE", value: percentOff },
    catalog: { id: "gid://shopify/MarketCatalog/markets-only-eu", title: "EU", __typename: "MarketCatalog" },
    prices: [],
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
  await prisma.campaign.update({
    where: { id: chaos.fixture.campaignId },
    data: { surfaces: { base: false, priceLists: [EU] } as never },
  });
  return chaos.fake.priceLists.find((list) => list.id === EU)!;
}

/** Every variant's base price, as the store holds it. */
const basePrices = (chaos: ChaosContext) =>
  new Map(chaos.fixture.variantGids.map((gid) => [gid, chaos.fake.priceOf(gid)]));

/** What Europe charges for each variant now, in cents. */
const europe = (chaos: ChaosContext) =>
  new Map(chaos.fixture.variantGids.map((gid) => [gid, parseMoney(chaos.fake.priceOf(gid, EU)!, "EUR").amount]));

/** The base-price writes the store accepted, and the base-price rows any run ledgered. */
async function baseTouched(chaos: ChaosContext) {
  return {
    writes: chaos.fake.writeLog.filter((write) => write.priceListGid === null).length,
    rows: await prisma.variantChange.count({ where: { shopId: chaos.fixture.shopId, surfaceKind: "BASE" } }),
  };
}

describe("chaos: a campaign for Europe alone (#1094)", () => {
  it("previews, applies and reverts without touching the base price, and Europe is priced from it", async () => {
    await withChaos("markets-only-base", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const euList = await europeOnly(chaos);
      const start = basePrices(chaos);
      const before = europe(chaos);

      // The review step: nothing on the base price, and Europe still priced.
      const preview = await previewCampaign(shopId, campaignId, { client });
      expect(preview.counts.planned, "the preview planned base prices this campaign never writes").toBe(0);
      expect(preview.markets.map((market) => [market.priceListGid, market.path])).toEqual([[EU, "market-wide"]]);
      // And it lists what it does price (#1111): every variant, its base price as it is, and
      // Europe's price beside it. It used to list nothing, so the euro prices had nowhere to go.
      expect(preview.marketsOnlyVariants).toBe(chaos.fixture.variantGids.length);
      expect(preview.rows.map((row) => row.variantGid).sort()).toEqual([...chaos.fixture.variantGids].sort());
      for (const row of preview.rows) {
        expect(row.before, `${row.variantGid}: no base price shown`).not.toBeNull();
        expect(row.after, `${row.variantGid}: the preview moved the base price`).toBe(row.before);
        expect(row.surfaces?.[EU]?.after, `${row.variantGid}: no price shown for Europe`).toBeTruthy();
      }

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      // What it verified is Europe's prices, which are all it writes (#1111): "0 verified" in
      // its outcome, its run row and its history, under six verified euro prices.
      const euroRows = await prisma.variantChange.count({ where: { runId: applied.runId, priceListGid: EU, status: "VERIFIED" } });
      expect(euroRows, "the premise: Europe's prices were ledgered and verified").toBe(chaos.fixture.variantGids.length);
      expect(applied.verified, "the outcome counted no verified prices").toBe(euroRows);
      expect((await prisma.campaignRun.findUniqueOrThrow({ where: { id: applied.runId } })).verifiedRows).toBe(euroRows);
      const transition = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, entityId: campaignId, action: "campaign.transition" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(transition.after), "the history said nothing was verified").toContain(`apply finished: ${euroRows} verified`);

      expect(basePrices(chaos), "a sale for Europe moved the price every shopper pays").toEqual(start);
      expect(await baseTouched(chaos)).toEqual({ writes: 0, rows: 0 });
      // 20% off what Europe charged, composed with the merchant's 10% onto a base price that
      // has not moved: 28%, and not 28% of a base price already 20% off.
      expect(chaos.fake.parentWrites.at(-1)).toMatchObject({ priceListGid: EU, type: "PERCENTAGE_DECREASE", value: 28 });
      for (const [gid, cents] of europe(chaos)) expect(cents).toBe(Math.round(before.get(gid)! * 0.8));
      // And the percentage alone lands within a cent of each, under whatever exact price the
      // read-back then wrote: under the double discount it was 20% short.
      for (const gid of chaos.fixture.variantGids) {
        const derived = parseMoney(chaos.fake.derivedPriceOf(gid, euList)!, "EUR").amount;
        expect(Math.abs(derived - Math.round(before.get(gid)! * 0.8)), `${gid}: the percentage was applied twice`).toBeLessThanOrEqual(1);
      }

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);

      expect(basePrices(chaos)).toEqual(start);
      expect(await baseTouched(chaos)).toEqual({ writes: 0, rows: 0 });
      expect(euList.adjustment).toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });
      expect(chaos.fake.fixedPricesOn(EU).size).toBe(0);
      expect(europe(chaos)).toEqual(before);
    });
  });

  it("resumes, and reverts one variant, without touching the base price", async () => {
    await withChaos("markets-only-resume", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await europeOnly(chaos);
      // Charm pricing, so Europe gets a price per product and a failed write can leave it partial.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { schedule: { ...(campaign.schedule as object), rounding: "charm99" } as never },
      });
      const start = basePrices(chaos);
      const before = europe(chaos);

      chaos.arm([{ fault: "server-error", match: (query) => query.includes("priceListFixedPricesAdd") }]);
      const applied = await chaos.apply();
      chaos.heal();
      expect((await chaos.expectHonest(applied.runId)).outcome, "nothing failed, so this resumes nothing").toBe("partial");

      const resumed = await chaos.apply({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(chaos.fake.fixedPricesOn(EU).size, "the resume did not price Europe").toBe(variantGids.length);
      expect(basePrices(chaos), "the resume moved the base price").toEqual(start);
      expect(await baseTouched(chaos)).toEqual({ writes: 0, rows: 0 });

      const [victim] = variantGids;
      await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      expect(basePrices(chaos), "reverting one variant moved the base price").toEqual(start);
      expect(await baseTouched(chaos)).toEqual({ writes: 0, rows: 0 });
      expect(europe(chaos).get(victim), "the variant stayed on sale in Europe").toBe(before.get(victim));
    });
  });

  it("does not record a product added during the sale at the sale's price", async () => {
    // Europe at parity with the store price, so the shortcut needs no exact prices and a
    // fixed price on the list can only be one this campaign wrote.
    await withChaos("markets-only-newcomer", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      await europeOnly(chaos, { currency: "USD", percentOff: 0 });

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.parentWrites.at(-1), "the premise: the list carries the campaign's 20%").toMatchObject({ value: 20 });
      expect(chaos.fake.fixedPricesOn(EU).size).toBe(0);

      // A $50 product joins the sale's scope while the list is 20% off.
      const variantGid = "gid://shopify/ProductVariant/1094-newcomer";
      chaos.fake.addVariant({ variantGid, productGid: "gid://shopify/Product/1094-newcomer", price: "50.00", compareAtPrice: null });
      await prisma.variantIndex.create({
        data: { shopId, variantGid, productGid: "gid://shopify/Product/1094-newcomer", title: "Newcomer", price: 5_000n, currency: "USD", status: "ACTIVE", tags: ["chaos"] },
      });
      await prisma.baseline.create({
        data: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "", currency: "USD", basePrice: 5_000n, source: "AUTO_ENROLL" },
      });
      expect(chaos.fake.priceOf(variantGid, EU), "the premise: the list prices it at the sale already").toBe("40.00");

      const enrolled = await chaos.apply({ variantGids: [variantGid] });
      await chaos.expectHonest(enrolled.runId);
      // $40.00 is the campaign's price, by the list's percentage. Recorded as the regular
      // price, the enrolment priced it 20% off again: a fixed $32.00.
      expect(chaos.fake.fixedPricesOn(EU).get(variantGid)?.amount, "priced 20% off the sale price").toBeUndefined();
      expect(chaos.fake.priceOf(variantGid, EU)).toBe("40.00");
      expect(
        await prisma.baseline.count({ where: { shopId, variantGid, priceListGid: EU, supersededAt: null } }),
        "recorded the sale price as the market's regular one",
      ).toBe(0);
      // Said with its cause: the list's percentage is the campaign's, and the store price never
      // moved (#1111). It was described as following "the store price, which a campaign had
      // already changed".
      const said = enrolled.messages.join(" ");
      expect(said).toMatch(/follows this market's percentage, which a campaign had already changed/);
      expect(said).not.toMatch(/follows the store price/);
    });
  });

  it("is not the price another campaign's apply or revert puts on the base price", async () => {
    await withChaos("markets-only-other-campaign", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await europeOnly(chaos);
      // Europe's 20% runs at priority 900 (the fixture's).
      await chaos.expectHonest((await chaos.apply()).runId);

      // A storewide 10% beneath it, on the base price only, over the same products.
      const storewide = await createCampaign(shopId, {
        name: "chaos/storewide-under-europe",
        priority: 100,
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      } as never);

      const applied = await runCampaign(shopId, storewide.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(applied.clean).toBe(true);
      for (const gid of variantGids) {
        expect(
          parseMoney(chaos.fake.priceOf(gid)!, "USD").amount,
          "the storewide sale wrote Europe's price on the base price",
        ).toBe(Math.round(baseline.get(gid)! * 0.9));
      }

      const reverted = await runCampaign(shopId, storewide.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
      expect(reverted.clean).toBe(true);
      for (const gid of variantGids) {
        expect(
          parseMoney(chaos.fake.priceOf(gid)!, "USD").amount,
          "ending the storewide sale handed the base price to Europe's",
        ).toBe(baseline.get(gid));
      }
    });
  });
});
