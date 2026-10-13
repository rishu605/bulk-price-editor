/**
 * A revert takes back every price its campaign wrote, and never says "prices are back"
 * from a mirror that is wrong (#828).
 *
 * A scheduled sale's end planned zero rows, marked the campaign Completed with "Prices are
 * back to what they would be without this campaign", and every sale price stayed live. A
 * revert plans from the mirror, so a mirror that read "baseline" -- a delayed product
 * webhook from before the apply, or anything else -- made every row look already done.
 *
 * Driven through the products webhook and the run path against the fake store, with only
 * `authenticate.webhook` replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown } = { shop: "", topic: "", payload: {} };
vi.mock("../../app/shopify.server", () => ({ authenticate: { webhook: async () => pending } }));

const dollars = (minor: number) => (minor / 100).toFixed(2);

async function deliver(shop: string, productGid: string, variants: Array<{ gid: string; price: string }>, updatedAt: Date) {
  pending = {
    shop,
    topic: "PRODUCTS_UPDATE",
    payload: {
      admin_graphql_api_id: productGid,
      title: "Webhook product",
      status: "active",
      tags: "chaos",
      updated_at: updatedAt.toISOString(),
      variants: variants.map((v) => ({ admin_graphql_api_id: v.gid, title: "M", price: v.price, inventory_quantity: 3 })),
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  return action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const mirrorPrice = async (shopId: string, variantGid: string) =>
  (await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid, surfaceKind: "BASE" } })).livePrice;

describe("chaos: reverting a sale whose mirror is wrong", () => {
  it("ignores a product webhook older than the sale's own write, and the revert restores every price", async () => {
    await withChaos("revert-stale-webhook", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, variantGids, productOf, baseline } = chaos.fixture;
      const beforeApply = new Date(Date.now() - 60_000);
      await chaos.expectHonest((await chaos.apply()).runId);

      // A payload from before the apply, delivered after it: the baseline price.
      const gid = variantGids[0];
      await deliver(domain, productOf.get(gid)!, [{ gid, price: dollars(baseline.get(gid)!) }], beforeApply);
      expect(await mirrorPrice(shopId, gid), "an older payload overwrote the sale's own write").toBe(BigInt(Math.round(baseline.get(gid)! * 0.8)));

      const reverted = await chaos.revert();
      expect(reverted.verified).toBe(variantGids.length);
      for (const g of variantGids) expect(chaos.fake.priceOf(g)).toBe(dollars(baseline.get(g)!));
    });
  });

  it("asks Shopify when the mirror says baseline, and writes the baseline back instead of reporting it done", async () => {
    await withChaos("revert-mirror-reset", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      // However it happened, the mirror now says every price is back at baseline. Shopify
      // still has the sale.
      for (const g of variantGids) {
        await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: g, surfaceKind: "BASE" }, data: { livePrice: BigInt(baseline.get(g)!) } });
      }

      const reverted = await chaos.revert();
      expect(reverted.planned, "the revert planned nothing and called it clean").toBe(variantGids.length);
      expect(reverted.clean).toBe(true);
      for (const g of variantGids) expect(chaos.fake.priceOf(g), "a sale price was left live").toBe(dollars(baseline.get(g)!));
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("COMPLETED");
    });
  });

  it("takes back a price the campaign wrote on a variant that has since left its scope (E6)", async () => {
    await withChaos("revert-left-scope", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      // The merchant untags one product mid-sale.
      const gone = variantGids[1];
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: gone }, data: { tags: ["something-else"] } });

      await chaos.revert();
      expect(chaos.fake.priceOf(gone), "a variant out of scope kept the sale price").toBe(dollars(baseline.get(gone)!));
    });
  });

  it("ends Partial, saying why, when a variant it wrote has no baseline to go back to", async () => {
    await withChaos("revert-no-baseline", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);

      await prisma.baseline.deleteMany({ where: { shopId, variantGid: variantGids[2] } });

      const reverted = await chaos.revert();
      expect(reverted.clean, "the revert said prices were back over one it could not restore").toBe(false);
      expect(reverted.messages.join(" ")).toMatch(/1 variant this campaign priced has no baseline to go back to/);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");
    });
  });

  it("stamps the mirror rows a run settles in UTC, like every other writer of them (#911)", async () => {
    await withChaos("revert-utc-stamp", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await chaos.expectHonest((await chaos.apply()).runId);
      // On a database whose session zone is not UTC -- the local one runs in Asia/Kolkata --
      // `NOW()` put these hours away from the webhook's and the sync's stamps.
      const entry = await prisma.priceSurfaceEntry.findFirstOrThrow({ where: { shopId, variantGid: variantGids[0], surfaceKind: "BASE" } });
      expect(Math.abs(entry.syncedAt.getTime() - Date.now()), "syncedAt is in another zone").toBeLessThan(60_000);
    });
  });
});
