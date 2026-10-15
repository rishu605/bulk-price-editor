/**
 * A hand-set price the catalogue sync baselined comes back when a sale on its list ends
 * (#1064).
 *
 * The sync mirrors every price list's fixed prices and then captures baselines over the
 * whole mirror. It recorded a market's hand-set price as a baseline without saying it was
 * hand-set, so the campaign never captured its own (#930) -- and the revert, reading a
 * baseline that did not say "hand-set", deleted the merchant's price and let the list's
 * percentage derive one instead. #930's own scenario passed only because its fixture
 * captured baselines before the price list existed; on a real shop the install sync runs
 * before any campaign does.
 *
 * The sync is the two steps `runFullSync` takes after the catalogue: `syncMarkets`, then
 * `captureBaselines` over the shop. The catalogue step is left out because the fake store
 * does not model the bulk query, and the fixture's catalogue is already mirrored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { parseMoney } from "../../app/lib/money/money";
import { captureBaselines } from "../../app/services/baselines.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

const MARKET = {
  kind: "a market",
  id: "gid://shopify/PriceList/eu-synced-hand-set",
  currency: "EUR",
  country: "DE" as string | undefined,
  catalog: { id: "gid://shopify/MarketCatalog/eu-synced", title: "EU", __typename: "MarketCatalog" },
};
const WHOLESALE = {
  kind: "a wholesale catalogue",
  id: "gid://shopify/PriceList/trade-synced-hand-set",
  currency: "USD",
  country: undefined,
  catalog: { id: "gid://shopify/CompanyLocationCatalog/synced", title: "Trade", __typename: "CompanyLocationCatalog" },
};
type List = typeof MARKET;

/**
 * A -10% list on which the merchant set two prices by hand -- one with a strike-through,
 * one without -- and left the third to the percentage. Then the sync, then a sale with its
 * own strike-through on the list.
 */
async function syncedWithHandSet(chaos: ChaosContext, list: List) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  const [struck, plain] = variantGids;
  chaos.fake.addPriceList({
    id: list.id,
    name: list.kind,
    currency: list.currency,
    ...(list.country ? { country: list.country } : {}),
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: list.catalog,
    prices: [
      { variantGid: struck, amount: "50.00", compareAt: "65.00", originType: "FIXED" as const },
      { variantGid: plain, amount: "50.00", compareAt: null, originType: "FIXED" as const },
    ],
  });

  // What the sync does after the catalogue.
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await captureBaselines(shopId);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { surfaces: { base: true, priceLists: [list.id] } as never, compareAtPolicy: { kind: "set-to-baseline" } as never },
  });
}

/** The hand-set prices are back as the merchant had them, and the derived one follows the list. */
function expectPutBack(chaos: ChaosContext, list: List, derivedBefore: string | undefined) {
  const [struck, plain, derived] = chaos.fixture.variantGids;
  const fixed = chaos.fake.fixedPricesOn(list.id);
  expect(fixed.get(struck), "the merchant's hand-set price was not put back as they had it").toEqual({ amount: "50.00", compareAt: "65.00" });
  expect(fixed.get(plain), "the merchant's hand-set price was not put back as they had it").toEqual({ amount: "50.00", compareAt: null });
  expect(fixed.has(derived), "a price the list derived was pinned").toBe(false);
  expect(chaos.fake.priceOf(derived, list.id)).toBe(derivedBefore);
}

describe("chaos: a hand-set price the catalogue sync baselined (#1064)", () => {
  it.each([MARKET, WHOLESALE])("comes back with its strike-through when a sale on $kind is reverted", async (list) => {
    await withChaos(`sync-hand-set-${list.currency}`, CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [struck, plain] = variantGids;
      await syncedWithHandSet(chaos, list);
      const [, , derived] = variantGids;
      const derivedBefore = chaos.fake.priceOf(derived, list.id);

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.fixedPricesOn(list.id).get(struck), "the sale never reached the hand-set price").toEqual({ amount: "40.00", compareAt: "50.00" });

      // The baselines the revert reads -- the sync's for a market, the campaign's own for a
      // wholesale catalogue, whose sync baselines are filed where no revert looks -- say
      // which prices were the merchant's.
      const read = await prisma.baseline.findMany({ where: { shopId, surfaceKind: "MARKET", priceListGid: list.id, supersededAt: null } });
      expect(new Map(read.map((b) => [b.variantGid, [b.handSet, b.baseCompareAt]])), "the baseline does not say the price was set by hand").toEqual(
        new Map([[struck, [true, 6_500n]], [plain, [true, null]], [derived, [false, null]]]),
      );
      expect(read.filter((b) => b.variantGid !== derived).map((b) => b.source)).toEqual(
        list === MARKET ? ["INSTALL_CAPTURE", "INSTALL_CAPTURE"] : ["AUTO_ENROLL", "AUTO_ENROLL"],
      );

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      expectPutBack(chaos, list, derivedBefore);
    });
  });

  it("comes back when the variant is reverted on its own", async () => {
    await withChaos("sync-hand-set-variant", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [struck] = variantGids;
      await syncedWithHandSet(chaos, MARKET);

      await chaos.expectHonest((await chaos.apply()).runId);
      const result = await revertVariant(shopId, campaignId, struck, chaosAdminClient(chaos.server.endpoint()), { actor: "chaos" });
      await chaos.expectHonest(result.outcome!.runId);
      expect(chaos.fake.fixedPricesOn(MARKET.id).get(struck), "the merchant's hand-set price was deleted").toEqual({ amount: "50.00", compareAt: "65.00" });
    });
  });

  // A shop that synced before this has the sync's baselines without the flag. The migration
  // marks them hand-set -- the sync only ever baselines a list's fixed prices -- and leaves
  // alone a market baseline a campaign captured before #930, which may be a derived price.
  it("comes back on a shop the sync baselined before the fix, once the migration has run", async () => {
    await withChaos("sync-hand-set-existing", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const [struck, , derived] = variantGids;
      await syncedWithHandSet(chaos, MARKET);
      const derivedBefore = chaos.fake.priceOf(derived, MARKET.id);

      // What the sync wrote before the fix, and what a campaign wrote before #930.
      await prisma.baseline.updateMany({ where: { shopId, priceListGid: MARKET.id }, data: { handSet: null } });
      await prisma.baseline.create({
        data: {
          shopId,
          variantGid: derived,
          surfaceKind: "MARKET",
          priceListGid: MARKET.id,
          currency: "EUR",
          basePrice: BigInt(parseMoney(derivedBefore!, "EUR").amount),
          source: "AUTO_ENROLL",
        },
      });

      // The migration's statement, confined to this shop: the chaos database is shared.
      const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261015120000_sync_baselines_hand_set/migration.sql"), "utf8");
      const statement = sql.replace(/--.*$/gm, "").trim().replace(/;$/, "");
      await prisma.$executeRawUnsafe(`${statement} AND "shopId" = $1`, shopId);

      const flags = await prisma.baseline.findMany({ where: { shopId, priceListGid: MARKET.id, supersededAt: null } });
      expect(new Map(flags.map((b) => [b.variantGid, b.handSet]))).toEqual(new Map([[struck, true], [variantGids[1], true], [derived, null]]));

      await chaos.expectHonest((await chaos.apply()).runId);
      await chaos.expectHonest((await chaos.revert()).runId);
      expectPutBack(chaos, MARKET, derivedBefore);
    });
  });
});
