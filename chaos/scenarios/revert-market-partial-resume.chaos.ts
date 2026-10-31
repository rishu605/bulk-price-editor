/**
 * A revert whose market prices are not taken back is Partial, and Resume finishes it (#706).
 *
 * #1001 made an apply count its market rows. A whole revert still did not: its deletes settle
 * the apply's rows rather than its own, so a revert whose euro deletes all failed ended
 * Completed -- "Finished and reverted. Prices are back to what they would be without this
 * campaign" -- with Europe still on sale, no next action, and a scheduler that ignores
 * Completed campaigns. And the failed delete marked the apply's rows FAILED, which took them
 * out of what the next revert takes back (#1035): even a second revert left Europe on sale.
 *
 * Rule 5: a run is clean only when every row is read back, and anything else is a visible,
 * resumable partial state. Each way a revert's market step can fall short is walked here --
 * a delete refused, a hand-set price not written back, a market-wide percentage not put back,
 * a market step that stopped -- and each ends Partial, then Completed after one Resume.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { runResponse } from "../../app/lib/campaigns/run-response";
import { describeState } from "../../app/lib/lifecycle/transitions";
import { partialProgress } from "../../app/services/campaigns/result.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const SPEC = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;
const EUR = "gid://shopify/PriceList/eu-revert-partial";
const JPY = "gid://shopify/PriceList/jp-revert-partial";

/** A market priced by a percentage of the store price, with no price of its own set by hand. */
function percentageMarket(chaos: ChaosContext, id: string, currency: string, country: string, adjustment: { type: string; value: number }) {
  chaos.fake.addPriceList({
    id,
    name: `${country} percentage`,
    currency,
    country,
    adjustment,
    catalog: { id: `${id}/catalog`, title: country, __typename: "MarketCatalog" },
    prices: [],
  });
}

async function target(chaos: ChaosContext, priceLists: string[], base = true) {
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
  await prisma.campaign.update({
    where: { id: chaos.fixture.campaignId },
    data: { surfaces: { base, priceLists } as never },
  });
}

const statusOf = async (campaignId: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

/** Faults nothing: records the list each fixed-price delete was sent to. */
function deletesSent(chaos: ChaosContext): string[] {
  const sent: string[] = [];
  chaos.arm([
    {
      fault: "server-error",
      match: (query, variables) => {
        if (query.includes("priceListFixedPricesDelete")) sent.push(String(variables.priceListId));
        return false;
      },
    },
  ]);
  return sent;
}

describe("chaos: a revert whose market prices are not taken back (#706)", () => {
  it("is Partial when a market's deletes fail, on apply and on revert, and each Resume finishes it", async () => {
    await withChaos("revert-market-partial-delete", SPEC, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      percentageMarket(chaos, EUR, "EUR", "DE", { type: "PERCENTAGE_DECREASE", value: 10 });
      percentageMarket(chaos, JPY, "JPY", "JP", { type: "PERCENTAGE_INCREASE", value: 20 });
      await target(chaos, [EUR, JPY]);
      // A strike-through, so each market is given a fixed price per variant, and a revert has
      // one to delete.
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      const before = new Map(variantGids.map((gid) => [gid, [chaos.fake.priceOf(gid), chaos.fake.priceOf(gid, EUR), chaos.fake.priceOf(gid, JPY)]]));

      // ------------------------------------------------ apply: Europe's writes fail (#1001)
      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesAdd") && variables.priceListId === EUR },
      ]);
      const applied = await chaos.apply();
      chaos.heal();
      expect(chaos.fake.fixedPricesOn(EUR).size, "the fault did not take, so this tests nothing").toBe(0);
      expect((await chaos.expectHonest(applied.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId), "the campaign read Active with Europe at full price").toBe("PARTIAL");

      const resumedApply = await chaos.apply({ resume: true });
      await chaos.expectHonest(resumedApply.runId);
      expect(resumedApply.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      expect(chaos.fake.fixedPricesOn(EUR).size).toBe(variantGids.length);
      expect(chaos.fake.fixedPricesOn(JPY).size).toBe(variantGids.length);
      const onSale = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, EUR)]));

      // ------------------------------------------------ revert: Europe's deletes fail
      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesDelete") && variables.priceListId === EUR },
      ]);
      const reverted = await chaos.revert();
      chaos.heal();
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid), "the store price was not put back").toBe(before.get(gid)![0]);
        expect(chaos.fake.priceOf(gid, EUR), "the fault did not take, so this tests nothing").toBe(onSale.get(gid));
        expect(chaos.fake.priceOf(gid, JPY)).toBe(before.get(gid)![2]);
      }

      const verdict = await chaos.expectHonest(reverted.runId);
      expect(verdict.outcome, "the revert called itself clean with Europe still on sale").toBe("partial");
      expect(reverted.clean).toBe(false);
      expect(await statusOf(campaignId), "the campaign read Completed with Europe still on sale").toBe("PARTIAL");
      const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: reverted.runId } });
      expect(run.status).toBe("PARTIAL");
      expect(run.failedRows, "the revert's own count said nothing failed").toBe(variantGids.length);

      // The revert's ledger names every euro price it could not take back, and why.
      const refused = await prisma.variantChange.findMany({ where: { runId: reverted.runId, priceListGid: EUR } });
      expect(refused.map((row) => row.status)).toEqual(variantGids.map(() => "FAILED"));
      for (const row of refused) expect(row.failureReason).toMatch(/may still show the campaign's price\. Resume the revert/);
      // And the sale's rows still say its price is live there, which is what the next revert
      // takes back. They read FAILED, and nothing ever sent them again (#1035).
      const sale = await prisma.variantChange.findMany({ where: { runId: resumedApply.runId, priceListGid: EUR } });
      expect(sale.map((row) => row.status)).toEqual(variantGids.map(() => "VERIFIED"));

      // What the merchant reads: the failures, and Resume offered as a revert.
      const told = runResponse(reverted, "Reverted");
      expect(told.ok).toBe(false);
      expect(told.message).toMatch(/with 3 failures .* resume to retry/);
      const state = describeState("PARTIAL", await partialProgress(shopId, campaignId));
      expect(state.nextAction?.label, "Resume would not continue this revert").toBe("Resume revert");

      // ------------------------------------------------ Resume: Europe's deletes, and nothing else
      const writes = chaos.fake.writeLog.length;
      const deletes = deletesSent(chaos);
      const resumed = await chaos.revert({ resume: true });
      chaos.heal();
      await chaos.expectHonest(resumed.runId);
      expect(resumed.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(deletes, "the resume sent nothing to Europe, or re-sent Japan's").toEqual([EUR]);
      expect(chaos.fake.writeLog.slice(writes), "the resume rewrote prices already back").toEqual([]);
      expect(chaos.fake.fixedPricesOn(EUR).size).toBe(0);
      for (const gid of variantGids) {
        expect([chaos.fake.priceOf(gid), chaos.fake.priceOf(gid, EUR), chaos.fake.priceOf(gid, JPY)]).toEqual(before.get(gid));
      }
    });
  });

  it("is Partial when a hand-set market price cannot be written back, and Resume writes it", async () => {
    await withChaos("revert-market-partial-hand-set", SPEC, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: EUR,
        name: "DE hand-set",
        currency: "EUR",
        country: "DE",
        adjustment: null,
        catalog: { id: `${EUR}/catalog`, title: "DE", __typename: "MarketCatalog" },
        prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
      });
      await target(chaos, [EUR]);
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.priceOf(variantGids[0], EUR)).toBe("40.00");

      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesAdd") && variables.priceListId === EUR },
      ]);
      const reverted = await chaos.revert();
      chaos.heal();
      expect(chaos.fake.priceOf(variantGids[0], EUR), "the fault did not take, so this tests nothing").toBe("40.00");
      expect((await chaos.expectHonest(reverted.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      const notBack = await prisma.variantChange.findMany({ where: { runId: reverted.runId, priceListGid: EUR } });
      expect(notBack.map((row) => row.status)).toEqual(variantGids.map(() => "FAILED"));

      const writes = chaos.fake.writeLog.length;
      const resumed = await chaos.revert({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(chaos.fake.writeLog.slice(writes).map((write) => [write.priceListGid, write.price])).toEqual(variantGids.map(() => [EUR, "50.00"]));
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid, EUR), "the merchant's own price was never written back").toBe("50.00");
    });
  });

  it.each([
    { how: "Shopify refuses it", refuse: "user-error" as const },
    { how: "the market step stops on it", refuse: "server-error" as const },
  ])("is Partial when a market-wide percentage is not put back because $how, and Resume puts it back", async ({ refuse }) => {
    await withChaos(`revert-market-partial-wide-${refuse}`, { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { campaignId } = chaos.fixture;
      // A sale in Europe alone, on a market at the merchant's own 10% off: one percentage.
      percentageMarket(chaos, EUR, "EUR", "DE", { type: "PERCENTAGE_DECREASE", value: 10 });
      await target(chaos, [EUR], false);
      const euList = chaos.fake.priceLists.find((list) => list.id === EUR)!;
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(euList.adjustment, "the sale did not go on as one percentage").toEqual({ type: "PERCENTAGE_DECREASE", value: 28 });

      const fake = chaos.fake as unknown as { priceListUpdate: (variables: Record<string, unknown>) => unknown };
      const update = fake.priceListUpdate;
      if (refuse === "user-error") {
        fake.priceListUpdate = () => ({
          data: { priceListUpdate: { priceList: null, userErrors: [{ field: ["input", "parent"], message: "Adjustment could not be saved." }] } },
        });
      } else {
        chaos.arm([{ fault: "server-error", match: (query) => query.includes("priceListUpdate") }]);
      }
      const reverted = await chaos.revert();
      fake.priceListUpdate = update;
      chaos.heal();

      expect(euList.adjustment, "the fault did not take, so this tests nothing").toEqual({ type: "PERCENTAGE_DECREASE", value: 28 });
      expect(reverted.clean, "the revert called itself clean with Europe still at 28% off").toBe(false);
      expect((await chaos.expectHonest(reverted.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      // Still the campaign's percentage, so the next revert puts it back, and the next apply
      // does not take it for the merchant's (#705).
      const changes = await prisma.priceListChange.findMany({ where: { campaignId, priceListGid: EUR } });
      expect(changes.map((change) => change.status)).toEqual(["VERIFIED"]);
      // And the banner says nothing went back, though the sweep settled every euro row (#1162).
      const banner = describeState("PARTIAL", await partialProgress(chaos.fixture.shopId, campaignId)).explanation;
      expect(banner, "the banner counted prices still under the sale's percentage as put back").toMatch(/^It stopped before any price was put back/);

      const resumed = await chaos.revert({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(resumed.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(euList.adjustment, "Resume never put the merchant's own 10% back").toEqual({ type: "PERCENTAGE_DECREASE", value: 10 });
      expect(chaos.fake.fixedPricesOn(EUR).size, "the revert left an exact price behind").toBe(0);
    });
  });

  it("completes over a market deleted in Shopify, whose prices went with it", async () => {
    await withChaos("revert-market-partial-gone", SPEC, async (chaos) => {
      const { campaignId } = chaos.fixture;
      percentageMarket(chaos, EUR, "EUR", "DE", { type: "PERCENTAGE_DECREASE", value: 10 });
      await target(chaos, [EUR]);
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(EUR).size).toBeGreaterThan(0);

      // The merchant deletes the market mid-sale, and Shopify refuses a delete on a list it no
      // longer has. Nothing is on sale there, so this must not leave a Partial no Resume ends.
      chaos.fake.priceLists.splice(chaos.fake.priceLists.findIndex((list) => list.id === EUR), 1);
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("priceListFixedPricesDelete") }]);
      const reverted = await chaos.revert();
      chaos.heal();
      await chaos.expectHonest(reverted.runId);
      expect(reverted.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
    });
  });
});

/**
 * What #706 left (#1162). A market whose percentage the app cannot take off was Partial once
 * and Completed at the next Resume, unchecked. A Resume wrote again the hand-set prices the
 * revert had put back. The banner over a markets-only revert said nothing was put back when
 * some was. And a refused delete's message said it would be retried automatically.
 */
describe("chaos: a market revert resumed after it stopped part-way (#1162)", () => {
  it("stays Partial while a percentage the app cannot take off is on, says to clear it by hand, and completes once it is cleared", async () => {
    await withChaos("revert-market-hand-clear", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      percentageMarket(chaos, EUR, "EUR", "DE", { type: "PERCENTAGE_DECREASE", value: 10 });
      await target(chaos, [EUR], false);
      const euList = chaos.fake.priceLists.find((list) => list.id === EUR)!;
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(euList.adjustment, "the sale did not go on as one percentage").toEqual({ type: "PERCENTAGE_DECREASE", value: 28 });
      // A market with no percentage of its own before the sale. The fake derives no price on a
      // list without one, so the market is given one and the ledger told it had none, which
      // is how such a market reads to the revert.
      await prisma.priceListChange.updateMany({ where: { campaignId, priceListGid: EUR }, data: { priorAdjustmentBps: null } });
      const parentWrites = chaos.fake.parentWrites.length;

      const reverted = await chaos.revert();
      expect(chaos.fake.parentWrites.length, "the revert set a percentage the market never had").toBe(parentWrites);
      expect(reverted.clean).toBe(false);
      expect((await chaos.expectHonest(reverted.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      const handClear = /DE percentage had no market-wide percentage of its own before this campaign.*Clear it in Shopify's Markets settings, then Resume the revert/;
      expect(reverted.messages.join(" "), "the revert did not say, by name, what to clear and where").toMatch(handClear);
      expect(describeState("PARTIAL", await partialProgress(shopId, campaignId)).explanation, "the banner did not say it").toMatch(handClear);

      // Resumed with the percentage still on. This read Completed, with Europe still 28% off.
      const again = await chaos.revert({ resume: true });
      expect(again.clean, "Resume ended the revert without checking the market").toBe(false);
      expect((await chaos.expectHonest(again.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");
      expect(again.messages.join(" ")).toMatch(handClear);
      expect(chaos.fake.parentWrites.length).toBe(parentWrites);
      // Still the campaign's percentage, so nothing else takes the list for the merchant's.
      const onList = await prisma.priceListChange.findMany({ where: { campaignId, priceListGid: EUR } });
      expect(onList.map((change) => change.status)).toEqual(["VERIFIED"]);

      // The merchant clears it in Shopify's Markets settings, then resumes.
      euList.adjustment = null;
      const resumed = await chaos.revert({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(resumed.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      const cleared = await prisma.priceListChange.findMany({ where: { campaignId, priceListGid: EUR } });
      expect(cleared.map((change) => change.status)).toEqual(["REVERTED"]);
    });
  });

  it("resumes without writing again the hand-set market prices the revert already put back", async () => {
    await withChaos("revert-market-resume-outstanding", SPEC, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: EUR,
        name: "DE hand-set",
        currency: "EUR",
        country: "DE",
        adjustment: null,
        catalog: { id: `${EUR}/catalog`, title: "DE", __typename: "MarketCatalog" },
        prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
      });
      percentageMarket(chaos, JPY, "JPY", "JP", { type: "PERCENTAGE_INCREASE", value: 20 });
      await target(chaos, [EUR, JPY]);
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, JPY)]));
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(JPY).size).toBe(variantGids.length);

      // Europe's own prices go back; Japan's sale prices cannot be taken off.
      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesDelete") && variables.priceListId === JPY },
      ]);
      const reverted = await chaos.revert();
      chaos.heal();
      expect((await chaos.expectHonest(reverted.runId)).outcome).toBe("partial");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid, EUR)).toBe("50.00");
      expect(chaos.fake.fixedPricesOn(JPY).size, "the fault did not take, so this tests nothing").toBe(variantGids.length);
      // Named as the ledger row names it, not as a write the executor will retry by itself.
      expect(reverted.messages.join(" "), "the message said the delete would be retried automatically").not.toMatch(/retried automatically/);
      expect(reverted.messages).toContain(
        "JP percentage: This variant's fixed price could not be removed, so this market may still show the campaign's price. Resume the revert to retry.",
      );

      const writes = chaos.fake.writeLog.length;
      const deletes = deletesSent(chaos);
      const resumed = await chaos.revert({ resume: true });
      chaos.heal();
      await chaos.expectHonest(resumed.runId);
      expect(resumed.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      expect(deletes).toEqual([JPY]);
      expect(chaos.fake.writeLog.slice(writes), "the resume wrote again the hand-set prices the revert had put back").toEqual([]);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, EUR)).toBe("50.00");
        expect(chaos.fake.priceOf(gid, JPY)).toBe(before.get(gid));
      }
    });
  });

  it("counts on the Partial banner of a markets-only revert the market prices it put back", async () => {
    await withChaos("revert-market-banner-counts", SPEC, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      percentageMarket(chaos, EUR, "EUR", "DE", { type: "PERCENTAGE_DECREASE", value: 10 });
      percentageMarket(chaos, JPY, "JPY", "JP", { type: "PERCENTAGE_INCREASE", value: 20 });
      // Europe and Japan only, each given a price per variant for its strike-through.
      await target(chaos, [EUR, JPY], false);
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      const before = new Map(variantGids.map((gid) => [gid, [chaos.fake.priceOf(gid, EUR), chaos.fake.priceOf(gid, JPY)]]));
      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(EUR).size).toBe(variantGids.length);
      expect(chaos.fake.fixedPricesOn(JPY).size).toBe(variantGids.length);

      const refuseEurope = () =>
        chaos.arm([
          { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesDelete") && variables.priceListId === EUR },
        ]);
      refuseEurope();
      const reverted = await chaos.revert();
      chaos.heal();
      expect((await chaos.expectHonest(reverted.runId)).outcome).toBe("partial");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid, JPY), "Japan's prices did not go back").toBe(before.get(gid)![1]);
      const banner = async () => describeState("PARTIAL", await partialProgress(shopId, campaignId)).explanation;
      expect(await banner(), "the banner said nothing was put back with Japan back to normal").toMatch(/^Some prices were put back and verified/);

      // Resumed while Europe still refuses: Japan's went back in the revert it continues.
      refuseEurope();
      const again = await chaos.revert({ resume: true });
      chaos.heal();
      expect((await chaos.expectHonest(again.runId)).outcome).toBe("partial");
      expect(await banner()).toMatch(/^Some prices were put back and verified/);

      const resumed = await chaos.revert({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) expect([chaos.fake.priceOf(gid, EUR), chaos.fake.priceOf(gid, JPY)]).toEqual(before.get(gid));
    });
  });
});
