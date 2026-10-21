/**
 * An apply whose market prices do not land is Partial, and Resume finishes it (#1001).
 *
 * A run's status was decided by the base surface alone. Every euro write could fail and the
 * run still ended Completed, the campaign Active -- "every row was read back and verified" --
 * with the base price on sale and Europe at full price, and nothing offering to fix it. Rule
 * 5: a run is clean only when every row is read back, and anything else is a visible,
 * resumable partial state. A market row is a row.
 *
 * Resume then has to retry exactly what is outstanding: the market rows that failed, and not
 * the base prices or the other market's prices, which landed.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { partialProgress } from "../../app/services/campaigns/result.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { runResponse } from "../../app/lib/campaigns/run-response";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const SPEC = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;
const EUR = "gid://shopify/PriceList/eu-partial-resume";
const GBP = "gid://shopify/PriceList/gb-partial-resume";
const JP = "gid://shopify/PriceList/jp-partial-resume";

/** A market with every variant's price set by hand, so the sale is a fixed price per variant. */
function handSetMarket(chaos: ChaosContext, id: string, currency: string, country: string, amount: string) {
  chaos.fake.addPriceList({
    id,
    name: `${country} hand-set`,
    currency,
    country,
    adjustment: null,
    catalog: { id: `${id}/catalog`, title: country, __typename: "MarketCatalog" },
    prices: chaos.fixture.variantGids.map((variantGid) => ({ variantGid, amount, compareAt: null, originType: "FIXED" as const })),
  });
}

async function targetMarkets(chaos: ChaosContext, priceLists: string[]) {
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
  await prisma.campaign.update({
    where: { id: chaos.fixture.campaignId },
    data: { surfaces: { base: true, priceLists } as never },
  });
}

const statusOf = async (campaignId: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

describe("chaos: an apply whose market prices fail (#1001)", () => {
  it("ends Partial, run and campaign, and Resume retries only the market rows that failed", async () => {
    await withChaos("market-partial-resume", SPEC, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      handSetMarket(chaos, EUR, "EUR", "DE", "50.00");
      handSetMarket(chaos, GBP, "GBP", "GB", "45.00");
      await targetMarkets(chaos, [EUR, GBP]);

      // Europe's writes fail; the store price and Britain's land.
      chaos.arm([
        { fault: "server-error", match: (query, variables) => query.includes("priceListFixedPricesAdd") && variables.priceListId === EUR },
      ]);
      const applied = await chaos.apply();
      chaos.heal();
      expect(chaos.fake.priceOf(variantGids[0], EUR), "the fault did not take, so this tests nothing").toBe("50.00");
      expect(chaos.fake.priceOf(variantGids[0], GBP)).toBe("36.00");

      const verdict = await chaos.expectHonest(applied.runId);
      expect(verdict.outcome, "the run called itself clean over three euro prices that failed").toBe("partial");
      expect(applied.clean).toBe(false);
      expect(await statusOf(campaignId), "the campaign read Active with Europe at full price").toBe("PARTIAL");
      const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: applied.runId } });
      expect(run.status).toBe("PARTIAL");
      expect(run.failedRows, "the run's own count said nothing failed").toBe(variantGids.length);

      // What the merchant reads: the failures counted, Europe named, and Resume offered.
      const told = runResponse(applied, "Applied");
      expect(told.ok).toBe(false);
      expect(told.message).toMatch(/with 3 failures .* resume to retry/);
      expect(told.details.join(" ")).toMatch(/DE hand-set \(EUR\): 3 prices did not apply/);
      expect((await partialProgress(shopId, campaignId)).resumes, "Resume would not continue this apply").toBe("APPLY");

      // Resume: only the euro prices are sent.
      const writes = chaos.fake.writeLog.length;
      const resumed = await chaos.apply({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(resumed.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("ACTIVE");

      const sent = chaos.fake.writeLog.slice(writes);
      expect(sent.map((write) => write.priceListGid), "the resume re-sent prices that had landed").toEqual(variantGids.map(() => EUR));
      const ledgered = await prisma.variantChange.findMany({ where: { runId: resumed.runId } });
      expect(ledgered.map((row) => [row.priceListGid, row.status])).toEqual(variantGids.map(() => [EUR, "VERIFIED"]));
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid, EUR)).toBe("40.00");
        expect(chaos.fake.priceOf(gid, GBP)).toBe("36.00");
      }
    });
  });

  it("ends Partial when the market step stops before writing anything, and Resume prices the market", async () => {
    await withChaos("market-partial-stopped", SPEC, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      // A percentage list: the market step asks Shopify what it derives before writing.
      chaos.fake.addPriceList({
        id: JP,
        name: "Japan",
        currency: "JPY",
        country: "JP",
        adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
        catalog: { id: `${JP}/catalog`, title: "JP", __typename: "MarketCatalog" },
        prices: [],
      });
      await targetMarkets(chaos, [JP]);
      await prisma.campaign.update({ where: { id: campaignId }, data: { compareAtPolicy: { kind: "set-to-baseline" } as never } });
      // Stopped by the read-back of the parent adjustment: no market row is ever ledgered.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("AnchorPriceListParent") }]);

      const applied = await chaos.apply();
      chaos.heal();
      expect(applied.messages.join(" ")).toMatch(/market prices did not finish/);
      expect(await prisma.variantChange.count({ where: { runId: applied.runId, priceListGid: JP } }), "rows were ledgered, so this is the other test").toBe(0);
      expect((await chaos.expectHonest(applied.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");

      const resumed = await chaos.apply({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.fixedPricesOn(JP).has(gid), "Resume never priced the market").toBe(true);
    });
  });

  it("counts market prices sent and never read back as unverified, and Resume reads them", async () => {
    // A markets-only sale moves the list's own percentage, then reads back what Shopify
    // derived. Stopped between the two, every market row is ledgered and none confirmed.
    const WIDE = "gid://shopify/PriceList/eu-wide-partial-resume";
    await withChaos("market-partial-unread", { catalog: { products: 12, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: WIDE,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: `${WIDE}/catalog`, title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), chaos.fixture.shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: false, priceLists: [WIDE] } as never } });
      // The first read of what the list derives is before anything is written; the second is
      // the read-back after the percentage moved.
      chaos.arm([{ fault: "server-error", after: 1, match: (query) => query.includes("AnchorPriceListDerivedPrices") }]);

      const applied = await chaos.apply();
      chaos.heal();
      expect(chaos.fake.parentWrites.length, "the percentage was never moved, so this tests nothing").toBeGreaterThan(0);
      const rows = await prisma.variantChange.findMany({ where: { runId: applied.runId, priceListGid: WIDE } });
      expect(rows.map((row) => row.status)).toEqual(variantGids.map(() => "PENDING"));
      expect(applied.unverified, "prices sent and never read back were not counted").toBe(variantGids.length);
      expect((await chaos.expectHonest(applied.runId)).outcome).toBe("partial");
      expect(await statusOf(campaignId)).toBe("PARTIAL");

      const resumed = await chaos.apply({ resume: true });
      await chaos.expectHonest(resumed.runId);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
    });
  });
});
