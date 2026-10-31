/**
 * A market price recaptured at a running sale's own price (#1166).
 *
 * #781 found it for the base price: a 20% sale took a $100 board to $80, the catalogue was
 * recaptured over it, and the campaign went on reading "verified", proposed 80.00 → 64.00, and
 * reverted to 80.00 with nothing about the $100. The same happened on a market and a wholesale
 * catalogue, unflagged. A recapture takes a list's fixed prices from the mirror, the
 * campaign's own sale price among them, and records each as hand-set, so the board's €50 in
 * Europe became a €40 baseline: applying again took €40 to €32 without asking, and reverting
 * wrote €40 back as the merchant's own price. Its ledger rows record no price before them, so
 * nothing could compare.
 *
 * Now the campaign needs a decision on its page and on every list, before anyone opens it;
 * Apply asks for the word and names the compounding, on the page and on the run's own plan;
 * and the revert report gives the market price from before the campaign. A campaign for the
 * list alone, so the base price is never on sale and is left alone by the recapture: whatever
 * is flagged is the list's.
 *
 * And what #1166 left (#1171): the rollback export has a row per such market price, with the
 * price before the sale; a campaign counted under before the count existed is counted by the
 * scheduler's next tick; a list price that followed the base price before the sale, which the
 * recapture made hand-set, follows the list again once reverted, and the next sale there is
 * priced from the list's own price; and a market price past the change threshold asks for the
 * word as a base price does.
 *
 * Driven through the campaign page's own loader and action, its rollback export, the recapture
 * service the page and Flow call, and the real `tick`. Only `authenticate.admin` and
 * `adminClientForShop` are replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { DANGEROUS_PHRASE } from "../../app/lib/baselines/recapture";
import { parseMoney } from "../../app/lib/money/money";
import { marketsNotBeforeSentence } from "../../app/lib/reporting/rollback";
import { calendarFor, todayIn } from "../../app/services/calendar.server";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { startCheck } from "../../app/services/campaigns/start-confirmation.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { planRecapture, recapture } from "../../app/services/recapture.server";
import { tick } from "../../app/services/scheduler.server";
import { redefine } from "../harness/definition";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

/** A staff member's id, as App Bridge's session token carries it. */
const STAFF = "91614707946";
let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: STAFF },
      admin: chaosAdminContext(pending.endpoint),
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, pending.endpoint) };
});

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** The campaign page's action, as its buttons post to it. */
async function press(campaignId: string, fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  return (await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: formOf(fields) }),
    params: { id: campaignId },
    context: {},
  } as never)) as { ok: boolean; message: string };
}

/** The campaign page, as its loader hands it to the browser. */
async function page(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as unknown as Awaited<ReturnType<typeof import("../../app/routes/app.campaigns.$id").loader>>;
}

/** The rollback report's export, as its button fetches it: its lines. */
async function exported(campaignId: string): Promise<string[]> {
  const { loader } = await import("../../app/routes/app.export.$kind");
  const response = (await loader({
    request: new Request(`https://example.invalid/app/export/rollback?campaign=${campaignId}`),
    params: { kind: "rollback" },
    context: {},
  } as never)) as Response;
  return (await response.text()).trim().split("\n");
}

/** The campaign on the list and its Needs-a-decision filter, on Home, and on the calendar. */
async function everywhere(shopId: string, campaignId: string) {
  const [all, attention] = await Promise.all([
    listCampaigns(shopId, filtersFrom(new URLSearchParams())),
    listCampaigns(shopId, filtersFrom(new URLSearchParams("status=attention"))),
  ]);
  const { loader } = await import("../../app/routes/app._index");
  const home = (await loader({ request: new Request("https://example.invalid/app"), params: {}, context: {} } as never)) as unknown as {
    needsAttention: number;
  };
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const calendar = await calendarFor(shopId, shop.timezone, { view: "week", on: todayIn(shop.timezone), status: "attention" });
  return {
    label: all.campaigns.find((campaign) => campaign.id === campaignId)!.lifecycle.label,
    filtered: attention.campaigns.map((campaign) => campaign.id),
    home: home.needsAttention,
    calendar: calendar.days.flatMap((day) => day.entries).find((entry) => entry.campaignId === campaignId)?.lifecycle?.label ?? null,
  };
}

/** Its price list, with both variants' prices set by hand at €50 / $50, and the campaign on it alone, over the board. */
async function saleOnTheList(chaos: ChaosContext, list: (typeof LISTS)[number]) {
  const { shopId, campaignId, variantGids, domain } = chaos.fixture;
  pending = { shop: domain, endpoint: chaos.server.endpoint() };
  const [board, other] = variantGids;
  chaos.fake.addPriceList({
    id: list.id,
    name: list.name,
    currency: list.currency,
    ...(list.country ? { country: list.country } : {}),
    adjustment: null,
    catalog: list.catalog,
    prices: variantGids.map((variantGid) => ({ variantGid, amount: "50.00", compareAt: null, originType: "FIXED" as const })),
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: false, priceLists: [list.id] } as never } });
  await redefine(campaignId, { ast: { groups: [{ conditions: [{ field: "variantGid", value: [board!] }] }] } });
  return { board: board!, other: other! };
}

const LISTS = [
  {
    kind: "a market",
    id: "gid://shopify/PriceList/recapture-eu",
    name: "Europe",
    currency: "EUR",
    country: "DE" as string | undefined,
    catalog: { id: "gid://shopify/MarketCatalog/recapture-eu", title: "EU", __typename: "MarketCatalog" },
    before: /^€?50\.00/,
    sale: /^€?40\.00/,
  },
  {
    kind: "a wholesale catalogue",
    id: "gid://shopify/PriceList/recapture-trade",
    name: "Trade",
    currency: "USD",
    country: undefined,
    catalog: { id: "gid://shopify/CompanyLocationCatalog/recapture-trade", title: "Trade", __typename: "CompanyLocationCatalog" },
    before: /^\$?50\.00/,
    sale: /^\$?40\.00/,
  },
] as const;

const marketBaseline = (shopId: string, variantGid: string, priceListGid: string) =>
  prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid, surfaceKind: "MARKET", priceListGid, supersededAt: null } });

describe("chaos: a market or wholesale price recaptured over a running sale (#1166)", () => {
  it.each(LISTS)("on $kind: flags the campaign everywhere, asks before compounding, and gives the price before it", async (list) => {
    await withChaos(`recapture-market-during-sale-${list.currency}`, CATALOG, async (chaos) => {
      const { shopId, campaignId, domain } = chaos.fixture;
      const { board, other } = await saleOnTheList(chaos, list);
      const client = fixtureAdminClient(domain, chaos.server.endpoint())!;

      // 1. A 20% sale on the list alone: 50.00 to 40.00, a price of the board's own there.
      const basePrice = chaos.fake.priceOf(board);
      const applied = await press(campaignId, { intent: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      expect(chaos.fake.priceOf(board, list.id)).toBe("40.00");
      expect(chaos.fake.priceOf(board), "the premise: the base price is not on sale").toBe(basePrice);
      expect((await marketBaseline(shopId, board, list.id)).basePrice).toBe(5_000n);
      expect(await everywhere(shopId, campaignId), "the premise: a sale that needs nothing").toEqual({
        label: "Active",
        filtered: [],
        home: 0,
        calendar: null,
      });

      // 2. The whole catalogue recaptured over it, with the phrase. The board's list price is
      // now its baseline, as a price set by hand, superseding the €50 its sale was computed
      // from; the base prices are already their baselines and left alone. The other variant's
      // list price, which no campaign had baselined, is captured for the first time.
      const plan = await planRecapture(shopId);
      const result = await recapture(shopId, { confirmation: DANGEROUS_PHRASE, actor: `staff:${STAFF}`, expectedScope: plan.scope, client });
      expect(result).toMatchObject({ captured: 2, superseded: 1 });
      expect(await marketBaseline(shopId, board, list.id)).toMatchObject({ basePrice: 4_000n, handSet: true });
      expect((await marketBaseline(shopId, other, list.id)).basePrice).toBe(5_000n);

      // 3. Every list says so before anyone opens the campaign: the recapture counted it.
      const flaggedEverywhere = {
        label: "Active — needs a decision",
        filtered: [campaignId],
        home: 1,
        calendar: "Active — needs a decision",
      };
      expect(await everywhere(shopId, campaignId), "a list said plain Active over a list price at its sale price").toEqual(flaggedEverywhere);

      // 3a. And had it been recaptured under before the count was kept (#1171), with no count,
      // the lists said plain Active until something counted it: now the scheduler's next tick does.
      await prisma.planSummary.updateMany({ where: { campaignId }, data: { recapturedAtSale: null, recapturedCountedAt: null } });
      expect((await everywhere(shopId, campaignId)).label, "the premise: a campaign with no count reads Active").toBe("Active");
      await tick(new Date());
      expect(await everywhere(shopId, campaignId), "the tick left a campaign recaptured under before #1166 uncounted").toEqual(flaggedEverywhere);

      // 4. Its page: needing a decision, and saying where the remedy for a list price is.
      const flagged = await page(campaignId);
      expect(flagged.lifecycle.label).toBe("Active — needs a decision");
      expect(flagged.lifecycle.explanation).toContain("the baseline of 1 of its variants was recaptured at the sale price");
      expect(flagged.lifecycle.explanation).toContain("One is a market's or wholesale catalogue's price, which an import cannot set");
      expect(flagged.needsAttention, "the page's banner").toBe(true);
      expect(flagged.preview).toMatchObject({ recapturedAtSale: 1, recapturedInMarkets: 1 });

      // 5. Applying again would take the list from 40.00 to 32.00: Apply asks, naming it.
      expect(flagged.preview.blastRadius).toBe(true);
      expect(flagged.preview.confirm?.compounding).toEqual({ count: 1, title: board });
      const refused = await press(campaignId, { intent: "apply" });
      expect(refused.ok, "Apply compounded the list's sale without asking").toBe(false);
      expect(refused.message).toMatch(/would be discounted again: its baseline was recaptured at the sale price.*compounds the discount/);
      expect(chaos.fake.priceOf(board, list.id)).toBe("40.00");
      // And the run's own plan, so a stored preview that said less cannot skip the word (rule 4).
      await expect(runCampaign(shopId, campaignId, client, { actor: `staff:${STAFF}`, untypedPress: true })).rejects.toThrow(
        /compounds the discount/,
      );
      expect(chaos.fake.priceOf(board, list.id)).toBe("40.00");

      // 6. The revert report gives the list's price from before the campaign, and what to do.
      const markets = flagged.rollback!.marketsNotBefore!;
      expect(markets.count).toBe(1);
      expect(markets.examples).toHaveLength(1);
      expect(markets.examples[0]).toMatchObject({ title: board, market: list.name });
      expect(markets.examples[0]!.before).toMatch(list.before);
      expect(markets.examples[0]!.revertsTo).toMatch(list.sale);
      expect(marketsNotBeforeSentence(markets)).toMatch(
        new RegExp(`^1 market price reverts to this campaign's sale price, not the price before it: “.*” in ${list.name} reverts to .*40\\.00, not .*50\\.00\\.`),
      );
      // 6a. And the export has a row for it (#1171), with its market and the price before: the
      // sentence names three, and the export listed base prices only.
      const csv = await exported(campaignId);
      expect(csv[0]).toBe('"variant_gid","title","state","applied","live_now","reverts_to","before_campaign","market"');
      expect(csv.slice(1), "the export left the market price out").toEqual([
        expect.stringMatching(new RegExp(`^"${board}","[^"]*","clean","[^"]*40\\.00","[^"]*40\\.00","[^"]*40\\.00","[^"]*50\\.00","${list.name}"$`)),
      ]);

      // 7. Which is what reverting does: the sale price stays on the list as the merchant's own.
      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect(chaos.fake.fixedPricesOn(list.id).get(board)?.amount).toBe("40.00");
      expect(chaos.fake.priceOf(other, list.id)).toBe("50.00");
    });
  });

  it("says nothing new of a list sale nobody recaptured under, and reverts it to the merchant's price", async () => {
    await withChaos("recapture-market-during-sale-none", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      const { board } = await saleOnTheList(chaos, LISTS[0]);

      const applied = await press(campaignId, { intent: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      const live = await page(campaignId);
      expect(live.lifecycle.label).toBe("Active");
      expect(live.preview).toMatchObject({ recapturedAtSale: 0, recapturedInMarkets: 0 });
      expect(live.preview.confirm?.compounding).toBeUndefined();
      expect(live.rollback?.marketsNotBefore).toBeUndefined();

      // Applying again asks nothing and changes nothing: the list price is computed from its baseline.
      const again = await press(campaignId, { intent: "apply" });
      expect(again.ok, again.message).toBe(true);
      expect(chaos.fake.priceOf(board, LISTS[0].id)).toBe("40.00");

      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect(chaos.fake.priceOf(board, LISTS[0].id)).toBe("50.00");
    });
  });
});

/** A list with no fixed prices of its own: its 10% off the base price, so every price on it follows the base price. */
const FOLLOWING = {
  id: "gid://shopify/PriceList/recapture-follows",
  name: "Europe",
  currency: "EUR",
  catalog: { id: "gid://shopify/MarketCatalog/recapture-follows", title: "EU", __typename: "MarketCatalog" },
} as const;

/**
 * A 20% sale on that list alone, over the board, recaptured over with the phrase. The list works
 * the board's price out from the base price, so the sale is a fixed price of the board's own there,
 * and the recapture records that fixed price as the board's baseline, set by hand.
 */
async function recapturedOverAFollowingSale(chaos: ChaosContext) {
  const { shopId, campaignId, variantGids, domain } = chaos.fixture;
  pending = { shop: domain, endpoint: chaos.server.endpoint() };
  const board = variantGids[0]!;
  const client = fixtureAdminClient(domain, chaos.server.endpoint())!;
  chaos.fake.addPriceList({
    id: FOLLOWING.id,
    name: FOLLOWING.name,
    currency: FOLLOWING.currency,
    country: "DE",
    adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
    catalog: FOLLOWING.catalog,
    prices: [],
  });
  const { syncMarkets } = await import("../../app/services/markets-sync.server");
  await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
  await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: false, priceLists: [FOLLOWING.id] } as never } });
  await redefine(campaignId, { ast: { groups: [{ conditions: [{ field: "variantGid", value: [board] }] }] } });
  const before = chaos.fake.priceOf(board, FOLLOWING.id)!;

  const applied = await press(campaignId, { intent: "apply" });
  expect(applied.ok, applied.message).toBe(true);
  const sale = chaos.fake.fixedPricesOn(FOLLOWING.id).get(board)?.amount;
  expect(sale, "the premise: the sale is a fixed price on a list that otherwise follows the base price").toBeDefined();
  expect(sale).not.toBe(before);
  expect(await marketBaseline(shopId, board, FOLLOWING.id), "the premise: the price followed the list").toMatchObject({ handSet: false });

  const plan = await planRecapture(shopId);
  await recapture(shopId, { confirmation: DANGEROUS_PHRASE, actor: `staff:${STAFF}`, expectedScope: plan.scope, client });
  expect(await marketBaseline(shopId, board, FOLLOWING.id), "the premise: the recapture made it hand-set").toMatchObject({
    handSet: true,
    basePrice: BigInt(parseMoney(sale!, FOLLOWING.currency).amount),
  });
  return { board, before, sale: sale!, client };
}

/** The board's current baselines on that list that are set by hand. */
const handSetBaselines = (shopId: string, variantGid: string) =>
  prisma.baseline.count({ where: { shopId, variantGid, priceListGid: FOLLOWING.id, surfaceKind: "MARKET", supersededAt: null, handSet: true } });

describe("chaos: a list price that followed the base price, recaptured over its sale as set by hand (#1171)", () => {
  it("follows the list again once reverted, and the next sale is priced from the list's own price", async () => {
    await withChaos("recapture-market-following", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const { board, before, sale } = await recapturedOverAFollowingSale(chaos);

      // The Revert tab says reverting lets it follow the list again, and gives no row claiming
      // it reverts to the sale price: the export has none.
      const flagged = await page(campaignId);
      expect(flagged.lifecycle.label).toBe("Active — needs a decision");
      expect(flagged.rollback?.marketsNotBefore).toMatchObject({ count: 0, following: 1 });
      expect(marketsNotBeforeSentence(flagged.rollback!.marketsNotBefore)).toMatch(
        /^1 market price that followed its list before this campaign was recaptured at its sale price as a fixed price\. Reverting removes it, so it follows the list again/,
      );
      expect((await exported(campaignId)).slice(1)).toEqual([]);

      // Reverting removes the fixed price: the board follows the list, at its price from before the sale.
      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect(chaos.fake.fixedPricesOn(FOLLOWING.id).has(board), "the revert wrote the sale price back as a fixed price").toBe(false);
      expect(chaos.fake.priceOf(board, FOLLOWING.id)).toBe(before);
      expect(await handSetBaselines(shopId, board), "the sale price stayed its baseline, set by hand").toBe(0);

      // The next sale is computed from the list's own price, not from the old sale price.
      const again = await press(campaignId, { intent: "apply" });
      expect(again.ok, again.message).toBe(true);
      expect(chaos.fake.fixedPricesOn(FOLLOWING.id).get(board)?.amount, "the next sale compounded the old one").toBe(sale);
      expect(await marketBaseline(shopId, board, FOLLOWING.id)).toMatchObject({ handSet: false });
    });
  });

  it("follows the list again when only that variant is taken out of the sale", async () => {
    await withChaos("recapture-market-following-variant", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const { board, before, client } = await recapturedOverAFollowingSale(chaos);

      const result = await revertVariant(shopId, campaignId, board, client, { actor: `staff:${STAFF}` });
      expect(result.outcome?.clean, result.message).toBe(true);
      expect(chaos.fake.fixedPricesOn(FOLLOWING.id).has(board), "Revert this variant wrote the sale price back as a fixed price").toBe(false);
      expect(chaos.fake.priceOf(board, FOLLOWING.id)).toBe(before);
      expect(await handSetBaselines(shopId, board)).toBe(0);
    });
  });
});

describe("chaos: a market price past the change threshold asks for the word, as a base price does (#1171)", () => {
  it("asks before 60% off on the list alone: on the page, on the run's own plan and for a start nobody confirmed", async () => {
    await withChaos("market-depth-confirmation", { ...CATALOG, percent: -60 }, async (chaos) => {
      const { shopId, campaignId, domain } = chaos.fixture;
      const { board } = await saleOnTheList(chaos, LISTS[0]);
      const client = fixtureAdminClient(domain, chaos.server.endpoint())!;

      const preview = (await page(campaignId)).preview;
      expect(preview.counts.planned, "the premise: no base price moves").toBe(0);
      expect(preview.blastRadius, "60% off in Europe applied from a one-click dialog").toBe(true);
      expect(preview.confirm).toMatchObject({
        planned: 0,
        largeChanges: 1,
        marketLargeChanges: 1,
        largest: { title: board, market: "Europe", basisPoints: 6_000, direction: "down" },
      });
      expect(preview.confirm?.largest?.before).toMatch(/50\.00/);
      expect(preview.confirm?.largest?.after).toMatch(/20\.00/);

      const refused = await press(campaignId, { intent: "apply" });
      expect(refused.ok, "Apply took the list 60% down without asking").toBe(false);
      expect(refused.message).toMatch(/1 price moves more than 50% from its baseline.*the largest is “.*” in Europe, down 60%/);
      expect(chaos.fake.priceOf(board, LISTS[0].id)).toBe("50.00");
      // The run's own plan refuses an untyped press, and a start with nobody to type the word.
      await expect(runCampaign(shopId, campaignId, client, { actor: `staff:${STAFF}`, untypedPress: true })).rejects.toThrow(
        /in Europe, down 60%/,
      );
      const unconfirmed = (await startCheck(shopId, await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }))).unconfirmed;
      expect(unconfirmed).toMatch(/in Europe, down 60%\. Nobody has confirmed it/);
      expect(chaos.fake.priceOf(board, LISTS[0].id)).toBe("50.00");

      // Typed, it applies.
      const typed = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(typed.ok, typed.message).toBe(true);
      expect(chaos.fake.priceOf(board, LISTS[0].id)).toBe("20.00");
    });
  });
});
