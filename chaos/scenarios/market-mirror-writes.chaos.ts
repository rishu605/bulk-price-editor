/**
 * What's live shows the market prices a campaign wrote, and says who they are because of
 * (#779).
 *
 * After a run only the base surface was mirrored: nothing wrote `price_surface_entries` for
 * a market, so a price the app put on a market list was unknown to the mirror until the next
 * markets sync. What's live lists the mirror, so on dartmode-labs a sale price left in the
 * United States catalogue by #763 had no row at all -- four "Base price" rows, the one wrong
 * price on the storefront invisible -- and the variant was "because of" the campaign that had
 * just let it go. On a list the sync had mirrored before the sale, the old price sat beside
 * the campaign's ledger and What's live called the campaign's own write drift.
 *
 * Asserted against what the store holds, not against what the run says it did: after every
 * step the mirror's rows for a list are exactly the fixed prices the fake has on it, in both
 * directions, which is also what the next markets sync would make them.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { formatMinorUnits } from "../../app/lib/money/format";
import { parseMoney } from "../../app/lib/money/money";
import { reconciliationFiltersFrom } from "../../app/lib/reporting/export-filters";
import { settleMirror } from "../../app/services/campaigns/mirror.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { syncMarkets } from "../../app/services/markets-sync.server";
import { auditMirror } from "../../app/services/mirror-audit.server";
import { reconcile } from "../../app/services/reconciliation.server";
import { chaosAdminClient } from "../harness/http-client";
import { isVariantWrite } from "../harness/faults";
import { withChaos, type ChaosContext } from "../harness/scenario";

/** A list holding a hand-set €50 for every variant: rows the sync mirrored before the sale. */
const EU = "gid://shopify/PriceList/eu-mirror-writes";
/** A list deriving from a percentage: no fixed prices, so no rows, until a campaign writes one. */
const JP = "gid://shopify/PriceList/jp-mirror-writes";
/** A wholesale list, filed as B2B by the sync, so its rows must be too. */
const TRADE = "gid://shopify/PriceList/trade-mirror-writes";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

async function withLists(chaos: ChaosContext, lists: readonly string[]) {
  const { shopId, campaignId, variantGids } = chaos.fixture;
  if (lists.includes(EU)) {
    chaos.fake.addPriceList({
      id: EU,
      name: "Europe",
      currency: "EUR",
      country: "DE",
      adjustment: null,
      catalog: { id: "gid://shopify/MarketCatalog/eu-mirror-writes", title: "EU", __typename: "MarketCatalog" },
      prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
    });
  }
  if (lists.includes(JP)) {
    chaos.fake.addPriceList({
      id: JP,
      name: "Japan",
      currency: "JPY",
      country: "JP",
      adjustment: { type: "PERCENTAGE_INCREASE", value: 20 },
      catalog: { id: "gid://shopify/MarketCatalog/jp-mirror-writes", title: "JP", __typename: "MarketCatalog" },
      prices: [],
    });
  }
  if (lists.includes(TRADE)) {
    chaos.fake.addPriceList({
      id: TRADE,
      name: "Trade partners",
      currency: "USD",
      adjustment: { type: "PERCENTAGE_DECREASE", value: 30 },
      catalog: { id: "gid://shopify/CompanyLocationCatalog/mirror-writes", title: "Trade", __typename: "CompanyLocationCatalog" },
      prices: [],
    });
  }
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      surfaces: { base: true, priceLists: [...lists] } as never,
      // A strike-through on every market, so every list is written a fixed price per variant
      // rather than left to follow the base price -- the prices this ticket is about.
      compareAtPolicy: { kind: "set-to-baseline" } as never,
    },
  });
}

/** The fixed prices a list holds in the store, in its own minor units. */
function storeOf(chaos: ChaosContext, listGid: string) {
  const currency = chaos.fake.currencyOf(listGid);
  const out = new Map<string, { price: bigint | null; compareAt: bigint | null }>();
  for (const [gid, row] of chaos.fake.fixedPricesOn(listGid)) {
    out.set(gid, {
      price: BigInt(parseMoney(row.amount, currency).amount),
      compareAt: row.compareAt ? BigInt(parseMoney(row.compareAt, currency).amount) : null,
    });
  }
  return out;
}

async function mirrorOf(shopId: string, listGid: string) {
  const rows = await prisma.priceSurfaceEntry.findMany({ where: { shopId, priceListGid: listGid } });
  return new Map(rows.map((row) => [row.variantGid, { price: row.livePrice, compareAt: row.liveCompareAt }]));
}

/** The mirror says of this list exactly what the store holds: no row missing, none extra, none stale. */
async function expectMirrorIsStore(chaos: ChaosContext, listGid: string, when: string) {
  expect(await mirrorOf(chaos.fixture.shopId, listGid), `${listGid} ${when}`).toEqual(storeOf(chaos, listGid));
}

/** What's live for one variant, read as its loader reads the URL. */
async function whatsLive(chaos: ChaosContext, variantGid: string) {
  const { shopId, domain } = chaos.fixture;
  return reconcile(shopId, domain, reconciliationFiltersFrom(new URLSearchParams({ q: variantGid })), 1, 100);
}

describe("chaos: a campaign's market prices in the mirror and on What's live (#779)", () => {
  it("mirrors each verified market write as it lands, shows it with its campaign, and a sync agrees", async () => {
    await withChaos("market-mirror-writes", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withLists(chaos, [EU, JP, TRADE]);

      // Before: the sync's €50s, and nothing for the lists that derive.
      expect((await mirrorOf(shopId, EU)).size).toBe(variantGids.length);
      expect((await mirrorOf(shopId, JP)).size).toBe(0);
      expect((await mirrorOf(shopId, TRADE)).size).toBe(0);

      await chaos.expectHonest((await chaos.apply()).runId);

      // Every list was written, so the mirror has something to show for each.
      for (const list of [EU, JP, TRADE]) {
        expect(chaos.fake.fixedPricesOn(list).size, `${list} was never written, so this tests nothing`).toBe(variantGids.length);
        await expectMirrorIsStore(chaos, list, "after the apply");
      }
      // An existing row updated, strike-through included: €50 less 20%, struck through at €50.
      for (const gid of variantGids) {
        expect((await mirrorOf(shopId, EU)).get(gid)).toEqual({ price: 4_000n, compareAt: 5_000n });
      }
      // Filed under the surface the sync files the list under, so no second row for one price.
      const trade = await prisma.priceSurfaceEntry.findMany({ where: { shopId, priceListGid: TRADE } });
      expect(trade.map((row) => row.surfaceKind)).toEqual(variantGids.map(() => "B2B"));

      // What's live, filtered to one variant: a row per market, at its live price, because of
      // the campaign.
      const [victim] = variantGids;
      const page = await whatsLive(chaos, victim);
      expect(page.rows.map((row) => row.priceListGid).sort()).toEqual(["", EU, JP, TRADE].sort());
      for (const list of [EU, JP, TRADE]) {
        const row = page.rows.find((r) => r.priceListGid === list)!;
        expect(row.live, `${list}'s live price`).toBe(formatMinorUnits(storeOf(chaos, list).get(victim)!.price, chaos.fake.currencyOf(list)));
        expect(row.campaignId, `${list} is not because of the campaign`).toBe(campaignId);
        expect(row.campaignName).toBe("chaos/market-mirror-writes");
        expect(row.drifted, `${list}: the campaign's own write read as drift`).toBe(false);
        expect(row.offBaseline).toBe(true);
      }
      expect(page.counts.drifted, "the banner would say prices are not what we wrote").toBe(0);

      // A later complete read neither deletes nor changes what the run wrote.
      const ids = new Map((await prisma.priceSurfaceEntry.findMany({ where: { shopId, priceListGid: { not: "" } } })).map((row) => [row.id, row.livePrice]));
      await syncMarkets(client, shopId);
      const after = await prisma.priceSurfaceEntry.findMany({ where: { shopId, priceListGid: { not: "" } } });
      expect(new Map(after.map((row) => [row.id, row.livePrice])), "the sync replaced the run's rows").toEqual(ids);
      for (const list of [EU, JP, TRADE]) await expectMirrorIsStore(chaos, list, "after a sync");
      expect((await whatsLive(chaos, victim)).counts.drifted, "a sync made the campaign's write drift").toBe(0);
      expect((await auditMirror(client, shopId, { size: variantGids.length })).diverged).toBe(0);

      // A whole revert, whose base write for one variant fails, so the campaign is left Partial
      // -- still pricing that variant, and no longer pricing the rest. The lists that derive
      // lose their fixed prices, and with them their rows; the hand-set €50s are written back.
      const stuck = variantGids[2];
      chaos.arm([
        { fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === chaos.fixture.productOf.get(stuck) },
      ]);
      const reverted = await chaos.revert();
      chaos.heal();
      await chaos.expectHonest(reverted.runId);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");
      expect(chaos.fake.fixedPricesOn(JP).size).toBe(0);
      expect(chaos.fake.fixedPricesOn(TRADE).size).toBe(0);
      for (const list of [EU, JP, TRADE]) await expectMirrorIsStore(chaos, list, "after the revert");

      // What the revert put back is nobody's: not the revert's own write, and not the sale's
      // write it undid, though the campaign may still have prices live.
      const back = await whatsLive(chaos, victim);
      expect(back.rows.map((row) => row.priceListGid).sort()).toEqual(["", EU].sort());
      for (const row of back.rows) expect(row.campaignId, `${row.surface} is because of the campaign that reverted it`).toBeNull();
      expect(back.counts.drifted).toBe(0);
      // The one it could not put back is still the sale's.
      const still = (await whatsLive(chaos, stuck)).rows.find((row) => row.priceListGid === "")!;
      expect(still.campaignId, "the base price the revert could not write").toBe(campaignId);

      // And an ended campaign is nobody's reason for a price, even where its write stands.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETED" } });
      expect((await whatsLive(chaos, stuck)).rows.find((row) => row.priceListGid === "")!.campaignId).toBeNull();
    });
  });

  it("updates the market row when one variant is reverted out, and names no campaign that let it go", async () => {
    await withChaos("market-mirror-variant-revert", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withLists(chaos, [EU, JP]);
      await chaos.expectHonest((await chaos.apply()).runId);
      const [victim, excluded, kept] = variantGids;

      // "Revert this variant": recomputed without the campaign on every surface.
      const result = await revertVariant(shopId, campaignId, victim, client, { actor: "chaos" });
      expect(result.outcome?.clean).toBe(true);
      expect(chaos.fake.fixedPricesOn(EU).get(victim)).toEqual({ amount: "50.00", compareAt: null });
      for (const list of [EU, JP]) await expectMirrorIsStore(chaos, list, "after a variant revert");
      expect((await mirrorOf(shopId, EU)).get(victim)).toEqual({ price: 5_000n, compareAt: null });

      // Japan's price follows its percentage again, so it has no fixed price and no row
      // (#1002): only the hand-set Europe price is a price the list stores.
      expect(chaos.fake.fixedPricesOn(JP).has(victim), "the variant was pinned on Japan's percentage list").toBe(false);

      // What's live shows where it is now, and not "because of" the sale that let it go.
      const page = await whatsLive(chaos, victim);
      expect(page.rows.map((row) => row.priceListGid).sort()).toEqual(["", EU].sort());
      for (const row of page.rows) {
        expect(row.campaignId, `${row.surface} is because of the campaign that let it go`).toBeNull();
        expect(row.drifted).toBe(false);
        expect(row.offBaseline, `${row.surface} is still off its baseline`).toBe(false);
      }
      expect(page.rows.find((row) => row.priceListGid === EU)?.live).toBe("50.00");

      // Let go without a write, as the rollback report's "leave the merchant's edit" does: the
      // price stays, and the campaign no longer explains it.
      await revertVariant(shopId, campaignId, excluded, client, { actor: "chaos", excludeOnly: true });
      const left = await whatsLive(chaos, excluded);
      expect(left.rows).toHaveLength(3);
      for (const row of left.rows) expect(row.campaignId, `${row.surface} is because of a campaign that excluded it`).toBeNull();
      expect(left.rows.find((row) => row.priceListGid === EU)?.live, "an exclusion moved a price").toBe("40.00");

      // A variant still in the sale still names it, on every surface.
      for (const row of (await whatsLive(chaos, kept)).rows) expect(row.campaignId).toBe(campaignId);
    });
  });

  it("a sync that read a list before the run wrote it leaves the run's price alone", async () => {
    await withChaos("market-mirror-sync-race", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      const inner = chaosAdminClient(chaos.server.endpoint());
      await withLists(chaos, [EU]);

      // The campaign runs while a sync is between reading Europe's prices and storing them:
      // the page it holds says €50, and the list now says €40.
      let raced = false;
      const racing: AdminClient = {
        async request<T>(query: string, variables: Record<string, unknown>) {
          const response = await inner.request<T>(query, variables);
          if (!raced && query.includes("AnchorPriceListPrices") && variables.id === EU) {
            raced = true;
            await chaos.expectHonest((await chaos.apply()).runId);
          }
          return response;
        },
      };
      await syncMarkets(racing, shopId);
      expect(raced, "the sync never read Europe, so nothing raced").toBe(true);

      for (const gid of variantGids) expect(chaos.fake.fixedPricesOn(EU).get(gid)?.amount).toBe("40.00");
      await expectMirrorIsStore(chaos, EU, "after a sync that raced the run");
      expect((await whatsLive(chaos, variantGids[0])).counts.drifted, "the campaign's own price read as drift").toBe(0);
    });
  });

  it("mirrors the exact prices a market-wide percentage needed, and nothing it derives", async () => {
    // A markets-only campaign moves the list's own percentage, and Shopify derives every price
    // from it -- those are not fixed prices and get no row, exactly as the sync stores them.
    // The ones the read-back could not confirm get an exact price, and those are: in euros,
    // every one, since a percentage list answers in the shop's currency (#257, #1094).
    const WIDE = "gid://shopify/PriceList/eu-wide-mirror-writes";
    await withChaos("market-mirror-wide", { catalog: { products: 12, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      chaos.fake.addPriceList({
        id: WIDE,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/eu-wide-mirror-writes", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: false, priceLists: [WIDE] } as never } });

      await chaos.expectHonest((await chaos.apply()).runId);
      expect(chaos.fake.parentWrites.length, "the one-percentage path was not taken").toBeGreaterThan(0);
      expect(chaos.fake.fixedPricesOn(WIDE).size, "nothing needed an exact price, so this tests nothing").toBeGreaterThan(0);
      await expectMirrorIsStore(chaos, WIDE, "after a market-wide apply");
    });
  });

  it("a market write it cannot confirm leaves the price unknown, never the old one", async () => {
    await withChaos("market-mirror-unconfirmed", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      await withLists(chaos, [EU]);

      chaos.arm([{ fault: "server-error", match: (query) => query.includes("priceListFixedPricesAdd") }]);
      const applied = await chaos.apply();
      chaos.heal();
      // Partial, run and campaign, with Resume to finish it (#1001).
      const verdict = await chaos.expectHonest(applied.runId);
      expect(verdict.outcome, "an apply whose market prices failed reported clean").toBe("partial");
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");
      expect(applied.messages.join(" ")).toMatch(/Europe \(EUR\): 3 prices did not apply/);
      expect(chaos.fake.fixedPricesOn(EU).get(variantGids[0])?.amount, "the write landed, so this tests nothing").toBe("50.00");

      // Null is "we have not looked": not the €50 from before, not the €40 nobody confirmed.
      for (const gid of variantGids) {
        expect((await mirrorOf(shopId, EU)).get(gid)).toEqual({ price: null, compareAt: null });
      }
      expect((await whatsLive(chaos, variantGids[0])).counts.drifted).toBe(0);

      // The next sync says what Shopify holds.
      await syncMarkets(client, shopId);
      await expectMirrorIsStore(chaos, EU, "after a sync");

      // A run that stopped part-way through a market, its rows still unsettled: whatever the
      // list holds may be its write, so the mirror does not know (#802, #903).
      const run = await prisma.campaignRun.create({
        data: { shopId, campaignId, kind: "APPLY", status: "PARTIAL", occurrenceKey: "chaos-stopped", startedAt: new Date(), finishedAt: new Date() },
      });
      await prisma.variantChange.createMany({
        data: [variantGids[0], variantGids[1]].map((variantGid) => ({
          runId: run.id,
          shopId,
          variantGid,
          surfaceKind: "MARKET" as const,
          priceListGid: EU,
          currency: "EUR",
          intendedPrice: 4_000n,
          status: "PENDING" as const,
        })),
      });
      await settleMirror(run.id);
      const settled = await mirrorOf(shopId, EU);
      expect(settled.get(variantGids[0])).toEqual({ price: null, compareAt: null });
      expect(settled.get(variantGids[1])).toEqual({ price: null, compareAt: null });
      expect(settled.get(variantGids[2]), "a row the stopped run never sent").toEqual({ price: 5_000n, compareAt: null });
    });
  });
});
