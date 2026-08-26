/**
 * The trust view, against a real engine.
 *
 * This is the page that answers "are my prices right?" — so the only thing worth testing
 * is whether it tells the truth when they are not. A reconciliation view that showed
 * everything green while a price had been changed behind us would be worse than having
 * no such page, because a merchant would have checked and been reassured.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

async function view(chaos: ChaosContext, filters = {}) {
  const { reconcile } = await import("../../app/services/reconciliation.server");
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: chaos.fixture.shopId } });
  return reconcile(shop.id, shop.domain, filters, 1);
}

describe("chaos: the reconciliation view", () => {
  it("names the campaign that put each price where it is", async () => {
    await withChaos(
      "reconcile-why",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const page = await view(chaos);
        const priced = page.rows.filter((row) => row.campaignId !== null);

        expect(priced.length).toBeGreaterThan(0);
        for (const row of priced) {
          expect(row.campaignId).toBe(chaos.fixture.campaignId);
          // Off baseline is what a sale is. It must not read as a problem.
          expect(row.offBaseline).toBe(true);
          expect(row.drifted).toBe(false);
        }
        expect(page.counts.drifted).toBe(0);
      },
    );
  });

  it("catches a price somebody changed behind us, and says which", async () => {
    await withChaos(
      "reconcile-drift",
      { catalog: { products: 5, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // A merchant edits one price by hand in Shopify admin, and the webhook updates
        // the mirror. Our ledger still says what we wrote, and the two now disagree.
        const meddled = variantGids[0];
        await prisma.priceSurfaceEntry.updateMany({
          where: { shopId, variantGid: meddled, priceListGid: "" },
          data: { livePrice: BigInt(12_345) },
        });

        const page = await view(chaos, { driftedOnly: true });

        expect(page.counts.drifted).toBe(1);
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0].variantGid).toBe(meddled);
        expect(page.rows[0].drifted).toBe(true);
      },
    );
  });

  it("does not call a variant drifted when nothing was ever promised about it", async () => {
    await withChaos(
      "reconcile-untouched",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        // No campaign has run. Every price is at its baseline and nothing was written,
        // so nothing can have drifted — a page that flagged these would cry wolf on a
        // brand-new install.
        const page = await view(chaos);

        expect(page.counts.drifted).toBe(0);
        expect(page.rows.every((row) => row.drifted === false)).toBe(true);
        expect(page.rows.every((row) => row.campaignId === null)).toBe(true);
      },
    );
  });

  it("keeps each market on its own row", async () => {
    await withChaos(
      "reconcile-markets",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;

        chaos.fake.addPriceList({
          id: "gid://shopify/PriceList/eu",
          name: "Europe",
          currency: "EUR",
          country: "DE",
          adjustment: null,
          catalog: { id: "gid://shopify/MarketCatalog/eu", title: "EU", __typename: "MarketCatalog" },
          prices: variantGids.map((gid) => ({
            variantGid: gid,
            amount: "50.00",
            compareAt: null,
            originType: "FIXED" as const,
          })),
        });

        const { syncMarkets } = await import("../../app/services/markets-sync.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { surfaces: { base: true, priceLists: ["gid://shopify/PriceList/eu"] } as never },
        });

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const page = await view(chaos);
        const surfaces = new Set(page.rows.map((row) => row.priceListGid));

        // Both surfaces present. A view that collapsed them could not show the case
        // that actually goes wrong: the base price reverted, the market's still on sale.
        expect(surfaces.has("")).toBe(true);
        expect(surfaces.has("gid://shopify/PriceList/eu")).toBe(true);

        const eu = page.rows.find((row) => row.priceListGid === "gid://shopify/PriceList/eu");
        expect(eu?.currency).toBe("EUR");
        expect(eu?.surface).toBe("Europe");
      },
    );
  });

  it("narrows to one campaign in the database, not on the page", async () => {
    await withChaos(
      "reconcile-by-campaign",
      { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { campaignId } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const mine = await view(chaos, { campaignId });
        expect(mine.rows.length).toBeGreaterThan(0);
        expect(mine.rows.every((row) => row.campaignId === campaignId)).toBe(true);

        // A campaign that never ran controls nothing, and the count must say so rather
        // than quietly showing page one of everything.
        const other = await view(chaos, { campaignId: "does-not-exist" });
        expect(other.rows).toHaveLength(0);
      },
    );
  });

  it("agrees with a fresh read from Shopify, and heals when it does not", async () => {
    await withChaos(
      "reconcile-spot-check",
      { catalog: { products: 20, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const { shopId, variantGids } = chaos.fixture;

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        const { auditMirror } = await import("../../app/services/mirror-audit.server");
        const { chaosAdminClient } = await import("../harness/http-client");
        const client = chaosAdminClient(chaos.server.endpoint());

        // Clean store, clean check.
        const clean = await auditMirror(client, shopId, { size: 20 });
        expect(clean.checked).toBe(20);
        expect(clean.diverged).toBe(0);

        // Now corrupt the mirror without touching the store — the shape a missed webhook
        // takes. The spot check must find it, because the storefront is the truth and
        // this page is only a claim about it.
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: variantGids[0] },
          data: { price: BigInt(999) },
        });

        const dirty = await auditMirror(client, shopId, { size: 20 });
        expect(dirty.diverged).toBe(1);
        expect(dirty.healed).toBe(1);

        // Healed means healed: a third check finds nothing.
        const after = await auditMirror(client, shopId, { size: 20 });
        expect(after.diverged).toBe(0);
      },
    );
  });
});
