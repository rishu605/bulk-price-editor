/**
 * A store in any currency Shopify offers syncs, previews and applies a campaign (#1089).
 *
 * The precision table held 63 of the Admin schema's 162 currency codes. A store in Qatari
 * riyal read every price through `parseMoney(price, "QAR")`, which threw
 * `UnknownCurrencyError`: the bulk read stopped on the first price, the sync failed, and Home
 * quoted the throw -- a developer's note to register the code in currency.ts. Nothing could
 * be previewed or priced.
 *
 * Three currencies, through the whole sync as Home's button runs it and then the real
 * preview and run: QAR at two decimals, which the table lacked; MGA, which ISO 4217 gives
 * two decimals and Shopify stores in whole ariary, so the store here rounds what it is given
 * as Shopify does; and BHD at three, through the sync path no scenario took in a
 * three-decimal currency. The same minor units in each, so the expected prices line up.
 *
 * And a store whose currency really has no precision -- XXX, which the schema uses for a
 * currency Shopify does not recognise -- is told so on Home, by name, and support hears of
 * it, rather than reading a failed sync it can do nothing about.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { syncFailureHeading } from "../../app/lib/dashboard/sync-failure";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runFullSync, syncStateOf } from "../../app/services/sync-job.server";
import { chaosAdminClient } from "../harness/http-client";
import { CHAOS_ACTOR, withChaos, type ChaosContext } from "../harness/scenario";

/** 4,700 / 1,234 / 990 minor units, as Shopify writes each currency's amounts. */
const CASES = [
  { currency: "QAR", stored: ["47.00", "12.34", "9.90"], after: ["42.30", "11.11", "8.91"] },
  { currency: "MGA", stored: ["4700.0", "1234.0", "990.0"], after: ["4230", "1111", "891"] },
  { currency: "BHD", stored: ["4.700", "1.234", "0.990"], after: ["4.230", "1.111", "0.891"] },
] as const;

/** Leaves the store as Shopify has it and Anchor with nothing read: the first sync is the test. */
async function unsynced(chaos: ChaosContext, currency: string, prices: readonly string[]): Promise<void> {
  const { shopId, variantGids, productOf } = chaos.fixture;
  chaos.fake.shopCurrency = currency;
  variantGids.forEach((variantGid, index) => {
    chaos.fake.addVariant({ variantGid, productGid: productOf.get(variantGid)!, price: prices[index], compareAtPrice: null });
  });
  // The tag the fixture's campaign selects by, on the store, so the sync brings it back.
  for (const product of new Set(productOf.values())) chaos.fake.addMerchantTag(product, "chaos");

  await prisma.baseline.deleteMany({ where: { shopId } });
  await prisma.priceSurfaceEntry.deleteMany({ where: { shopId } });
  await prisma.variantIndex.deleteMany({ where: { shopId } });
  await prisma.shop.update({ where: { id: shopId }, data: { initialSyncCompletedAt: null } });
}

describe("chaos: a store in a currency the precision table lacked", () => {
  for (const { currency, stored, after } of CASES) {
    it(`syncs, previews and applies a campaign in ${currency}`, async () => {
      await withChaos(`shop-currency-${currency.toLowerCase()}`, { catalog: { products: 3, variantsPerProduct: 1, currency }, percent: -10 }, async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());
        await unsynced(chaos, currency, stored);
        // Shopify keeps a price at its own precision for the currency, whatever it is sent:
        // whole ariary for MGA, so 1110.60 is stored as 1111.0 and reads back as 1111.
        if (currency === "MGA") {
          chaos.fake.distortStoredPrice = (requested) => {
            const [whole, fraction = ""] = requested.split(".");
            if (/^0*$/.test(fraction)) return requested;
            return `${BigInt(whole) + (fraction[0] >= "5" ? 1n : 0n)}.0`;
          };
        }

        const sync = await runFullSync(shopId, client, CHAOS_ACTOR);
        expect(sync.errors, `the ${currency} sync reported problems`).toEqual([]);
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        expect(shop.syncFailure, "Home was told the sync did not finish").toBeNull();
        expect(shop.initialSyncCompletedAt, "the first sync was not recorded").not.toBeNull();

        const mirrored = await prisma.variantIndex.findMany({ where: { shopId }, orderBy: { variantGid: "asc" } });
        const byGid = new Map(mirrored.map((row) => [row.variantGid, row]));
        expect(variantGids.map((gid) => byGid.get(gid)?.price)).toEqual([4_700n, 1_234n, 990n]);
        expect(new Set(mirrored.map((row) => row.currency))).toEqual(new Set([currency]));
        const baselines = await prisma.baseline.findMany({ where: { shopId, surfaceKind: "BASE", supersededAt: null } });
        expect(baselines.map((row) => [row.currency, row.basePrice]).sort()).toEqual(
          [[currency, 1_234n], [currency, 4_700n], [currency, 990n]].sort(),
        );

        const preview = await previewCampaign(shopId, campaignId, { client });
        expect(variantGids.map((gid) => preview.rows.find((row) => row.variantGid === gid)?.after)).toEqual([...after]);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: applied.runId } });
        expect(run.status, `the ${currency} run did not end verified-clean`).toBe("COMPLETED");
        expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual([...after]);
      });
    });
  }

  it("tells a store in a currency with no precision so on Home, by name, and reports it to support", async () => {
    await withChaos("shop-currency-xxx", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      await unsynced(chaos, "XXX", ["12.00", "15.00"]);

      const sync = await runFullSync(shopId, chaosAdminClient(chaos.server.endpoint()), CHAOS_ACTOR);

      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      const home = syncStateOf(shop);
      expect(home.running).toBe(false);
      expect(home.failure).toBe(
        "Anchor can't price in your store's currency: Shopify reports it as XXX, its code for a currency it does not " +
          "recognise, so there is no telling how many decimal places your prices have. Anchor read none of your " +
          "products rather than guess, and nothing in your store was changed. Support has been sent this. Check the " +
          "store currency in your Shopify settings, then sync again from here.",
      );
      expect(sync.errors).toEqual([home.failure]);
      // Under a heading that says so, rather than "The last sync did not finish cleanly".
      expect(syncFailureHeading(home.failure ?? "")).toBe("Anchor can't price in your store's currency");

      // Nothing mirrored, and the store not recorded as synced: there is nothing to price.
      expect(await prisma.variantIndex.count({ where: { shopId } })).toBe(0);
      expect(shop.initialSyncCompletedAt).toBeNull();
      expect(chaos.fake.writeLog).toEqual([]);

      // Support's half: one error, for this shop, naming the currency.
      const reported = await prisma.errorEvent.findMany({ where: { shopId } });
      expect(reported).toHaveLength(1);
      expect(reported[0].context).toMatchObject({ currency: "XXX" });
      expect(reported[0].userMessage).toBe(home.failure);
    });
  });
});
