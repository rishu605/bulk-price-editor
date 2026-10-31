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
 * Driven through the campaign page's own loader and action and the recapture service the page
 * and Flow call. Only `authenticate.admin` and `adminClientForShop` are replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { DANGEROUS_PHRASE } from "../../app/lib/baselines/recapture";
import { marketsNotBeforeSentence } from "../../app/lib/reporting/rollback";
import { calendarFor, todayIn } from "../../app/services/calendar.server";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { planRecapture, recapture } from "../../app/services/recapture.server";
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
      expect(await everywhere(shopId, campaignId), "a list said plain Active over a list price at its sale price").toEqual({
        label: "Active — needs a decision",
        filtered: [campaignId],
        home: 1,
        calendar: "Active — needs a decision",
      });

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
