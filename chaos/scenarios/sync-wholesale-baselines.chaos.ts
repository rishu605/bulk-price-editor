/**
 * A wholesale price has one baseline, and a sync during a sale does not add a second at the
 * sale price (#1071).
 *
 * The mirror files a wholesale catalogue's prices under the surface kind B2B, and the sync's
 * capture filed their baselines under the same kind. Every engine path reads and writes a
 * price list's baseline as MARKET. So the campaign never saw the sync's baseline and captured
 * its own, and a sync during the sale, looking only for a B2B one, baselined the price the
 * campaign had just written. What's live joined both: its badge said 7 prices were off their
 * baseline above a table of 6.
 *
 * The sync is the two steps `runFullSync` takes after the catalogue: `syncMarkets`, then
 * `captureBaselines` over the shop with the sync's client. The catalogue step is left out
 * because the fake store does not model the bulk query, and the fixture's catalogue is
 * already mirrored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { captureBaselines } from "../../app/services/baselines.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { reconcile } from "../../app/services/reconciliation.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

const TRADE = {
  id: "gid://shopify/PriceList/trade-1071",
  catalog: { id: "gid://shopify/CompanyLocationCatalog/trade-1071", title: "Trade", __typename: "CompanyLocationCatalog" },
};

/** The quantity ladder the merchant set on the hand-set price: 12 or more at $45.00. */
const LADDER = [{ minimumQuantity: 12, amount: "45.00" }];

/**
 * A -10% wholesale catalogue. The first variant's price is set by hand at $50.00, with a
 * quantity ladder; the other two follow the percentage. The campaign is put on the base
 * price and the catalogue, with the strike-through set to the baseline.
 */
async function wholesaleCatalogue(chaos: ChaosContext) {
  const { campaignId, variantGids } = chaos.fixture;
  const [handSet] = variantGids;
  chaos.fake.addPriceList({
    id: TRADE.id,
    name: "Trade",
    currency: "USD",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: TRADE.catalog,
    prices: [{ variantGid: handSet!, amount: "50.00", compareAt: null, originType: "FIXED" as const }],
  });
  chaos.fake.ladders.set(`${TRADE.id}|${handSet}`, LADDER.map((rung) => ({ ...rung })));

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [TRADE.id] } as never, compareAtPolicy: { kind: "set-to-baseline" } as never },
  });
}

/** What the sync does after the catalogue. */
async function sync(chaos: ChaosContext) {
  const client = chaosAdminClient(chaos.server.endpoint());
  await syncMarkets(client, chaos.fixture.shopId);
  await captureBaselines(chaos.fixture.shopId, { client });
}

/**
 * What the sync's capture wrote before this fix, and what the release before writes still:
 * a B2B baseline from every wholesale price in the mirror without a current B2B one.
 */
async function syncAsBefore(chaos: ChaosContext) {
  const { shopId } = chaos.fixture;
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  const [entries, current] = await Promise.all([
    prisma.priceSurfaceEntry.findMany({ where: { shopId, surfaceKind: "B2B", livePrice: { not: null } } }),
    prisma.baseline.findMany({ where: { shopId, surfaceKind: "B2B", supersededAt: null }, select: { variantGid: true, priceListGid: true } }),
  ]);
  const has = new Set(current.map((row) => `${row.variantGid}|${row.priceListGid}`));
  await prisma.baseline.createMany({
    data: entries
      .filter((entry) => !has.has(`${entry.variantGid}|${entry.priceListGid}`))
      .map((entry) => ({
        shopId,
        variantGid: entry.variantGid,
        surfaceKind: "B2B" as const,
        priceListGid: entry.priceListGid,
        currency: entry.currency,
        basePrice: entry.livePrice!,
        baseCompareAt: entry.liveCompareAt,
        source: "INSTALL_CAPTURE" as const,
      })),
  });
}

/** Each wholesale price has exactly one current baseline, filed as MARKET, at `prices`. */
async function expectOneBaselineEach(chaos: ChaosContext, prices: Map<string, string | undefined>) {
  const { shopId } = chaos.fixture;
  const current = await prisma.baseline.findMany({ where: { shopId, priceListGid: TRADE.id, supersededAt: null } });
  expect(
    current.map((row) => `${row.variantGid} ${row.surfaceKind}`).sort(),
    "a wholesale price does not have exactly one current baseline, filed where the campaign reads it",
  ).toEqual([...prices.keys()].map((gid) => `${gid} MARKET`).sort());
  expect(
    new Map(current.map((row) => [row.variantGid, (Number(row.basePrice) / 100).toFixed(2)])),
    "a wholesale baseline is not the price from before the sale",
  ).toEqual(prices);
  expect(await prisma.baseline.count({ where: { shopId, surfaceKind: "B2B", supersededAt: null } }), "a B2B baseline is still current").toBe(0);
}

/** What's live's off-baseline badge counts the rows its table lists, and how many those are. */
async function expectWhatsLiveAgrees(chaos: ChaosContext, rows: number) {
  const { shopId, domain } = chaos.fixture;
  const badge = (await reconcile(shopId, domain)).counts.offBaseline;
  const table = await reconcile(shopId, domain, { offBaselineOnly: true }, 1, 100);
  expect({ badge, table: table.total, listed: table.rows.length }, "What's live's badge disagrees with its table").toEqual({
    badge: rows,
    table: rows,
    listed: rows,
  });
}

describe("chaos: a wholesale price's baseline, and the sync (#1071)", () => {
  it("keeps one baseline per wholesale price when a sync runs during a sale, at the price from before it", async () => {
    await withChaos("sync-wholesale-sale", CATALOG, async (chaos) => {
      const { variantGids } = chaos.fixture;
      const [handSet, ...derived] = variantGids;
      await wholesaleCatalogue(chaos);
      await sync(chaos);
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, TRADE.id)]));
      expect(before.get(handSet!)).toBe("50.00");

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(TRADE.id).get(handSet!), "the sale never reached the wholesale catalogue").toEqual({ amount: "40.00", compareAt: "50.00" });
      for (const gid of derived) expect(chaos.fake.fixedPricesOn(TRADE.id).has(gid), "the sale never reached a derived price").toBe(true);

      // During the sale: the campaign's prices are in the mirror now, as fixed prices.
      await sync(chaos);
      await expectOneBaselineEach(chaos, before);
      // Three base prices and three wholesale ones, each counted once.
      await expectWhatsLiveAgrees(chaos, 6);

      await chaos.expectHonest((await chaos.revert()).runId);
      expect(chaos.fake.fixedPricesOn(TRADE.id).get(handSet!), "the hand-set wholesale price was not put back").toEqual({ amount: "50.00", compareAt: null });
      for (const gid of derived) expect(chaos.fake.priceOf(gid, TRADE.id), "a derived wholesale price did not go back to following the list").toBe(before.get(gid));

      await sync(chaos);
      await expectOneBaselineEach(chaos, before);
      await expectWhatsLiveAgrees(chaos, 0);
    });
  });

  it("records the merchant's quantity ladder on the sync's baseline, which is the one the campaign computes from", async () => {
    await withChaos("sync-wholesale-ladder", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [handSet] = variantGids;
      await wholesaleCatalogue(chaos);

      // A capture that cannot ask Shopify for the ladder -- an auto-enrolment, say -- leaves
      // the wholesale price alone rather than record "no ladder" it never looked for.
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await captureBaselines(shopId);
      expect(await prisma.baseline.count({ where: { shopId, priceListGid: TRADE.id } }), "a wholesale baseline was recorded without reading its ladder").toBe(0);

      // Nor does a sync that asked and got no answer.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("AnchorPriceListQuantityBreaks") }]);
      await sync(chaos);
      chaos.heal();
      expect(await prisma.baseline.count({ where: { shopId, priceListGid: TRADE.id } }), "a ladder Shopify did not answer for was recorded as none").toBe(0);

      await sync(chaos);
      const synced = await prisma.baseline.findMany({ where: { shopId, priceListGid: TRADE.id, supersededAt: null } });
      expect(
        synced.map(({ variantGid, surfaceKind, basePrice, quantityBreaks, handSet: fixed, source }) => ({ variantGid, surfaceKind, basePrice, quantityBreaks, fixed, source })),
        "the sync did not baseline the hand-set wholesale price with its ladder, where the campaign reads it",
      ).toEqual([
        {
          variantGid: handSet,
          surfaceKind: "MARKET",
          basePrice: 5_000n,
          quantityBreaks: [{ minimumQuantity: 12, amount: 4_500 }],
          fixed: true,
          source: "INSTALL_CAPTURE",
        },
      ]);

      await chaos.expectHonest((await chaos.apply()).runId);
      const used = await prisma.baseline.findMany({ where: { shopId, variantGid: handSet, priceListGid: TRADE.id } });
      expect(used.map((row) => row.id), "the campaign captured a baseline of its own beside the sync's").toEqual([synced[0]!.id]);
    });
  });

  // A shop the sync baselined before the fix has a B2B baseline beside each wholesale price,
  // at the sale price where a sync ran during a sale. The migration supersedes them all: the
  // campaign never read one, and its own MARKET baselines stay. A sync by the release before,
  // in a rollback, writes them again, and the next sync puts them away.
  it("supersedes the duplicates on a shop the sync baselined before the fix, once the migration has run", async () => {
    await withChaos("sync-wholesale-existing", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [handSet] = variantGids;
      await wholesaleCatalogue(chaos);
      await syncAsBefore(chaos);
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid, TRADE.id)]));

      await chaos.expectHonest((await chaos.apply()).runId);
      await syncAsBefore(chaos);

      // The state #1071 found: three base cells and three wholesale ones off their baseline,
      // and the badge counting the hand-set one twice.
      const { domain } = chaos.fixture;
      expect((await reconcile(shopId, domain)).counts.offBaseline).toBe(7);
      expect((await reconcile(shopId, domain, { offBaselineOnly: true })).total).toBe(6);

      // The migration's statement, confined to this shop: the chaos database is shared.
      const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261021090000_wholesale_baselines_one_kind/migration.sql"), "utf8");
      const statement = sql.replace(/--.*$/gm, "").trim().replace(/;$/, "");
      await prisma.$executeRawUnsafe(`${statement} AND "shopId" = $1`, shopId);

      await expectOneBaselineEach(chaos, before);
      await expectWhatsLiveAgrees(chaos, 6);
      // Superseded, not deleted: the history stays.
      expect(await prisma.baseline.count({ where: { shopId, surfaceKind: "B2B", supersededAt: { not: null } } })).toBe(3);

      // The release before, rolled back to, syncs during the sale; this one syncs after it.
      await syncAsBefore(chaos);
      expect(await prisma.baseline.count({ where: { shopId, surfaceKind: "B2B", supersededAt: null } })).toBe(3);
      await sync(chaos);
      await expectOneBaselineEach(chaos, before);
      await expectWhatsLiveAgrees(chaos, 6);

      await chaos.expectHonest((await chaos.revert()).runId);
      expect(chaos.fake.fixedPricesOn(TRADE.id).get(handSet!), "the hand-set wholesale price was not put back").toEqual({ amount: "50.00", compareAt: null });
    });
  });
});
