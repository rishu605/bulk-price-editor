/**
 * Anchor's own write on a variant with a compare-at, from a "leave" campaign (#731).
 *
 * Before each write the run records an intent, so drift can recognise the echo webhook as
 * ours. A campaign whose compare-at policy is "leave" recorded compare-at as `null` -- but
 * the echo carries the compare-at the variant already had, because "leave" left it there.
 * So on any variant with a compare-at, Anchor's own write did not match its own intent:
 * a DriftEvent, an email, and the controlling campaign HELD, which stops its scheduled end
 * and leaves its prices live. Every spreadsheet import uses "leave".
 *
 * The echo is delivered through the products webhook while the mirror still holds the
 * pre-run price, which is when it really arrives: the mirror is refreshed after the whole
 * run. Only `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

async function deliver(shop: string, productGid: string, variantGid: string, price: string, compareAt: string) {
  pending = {
    shop,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: productGid,
      title: "Echo product",
      status: "active",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: compareAt }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

describe("chaos: a 'leave' campaign's own write on a variant with a compare-at", () => {
  it("is recognised as ours, not merchant drift, and holds nothing", async () => {
    await withChaos("leave-compare-at-echo", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect((campaign.compareAtPolicy as { kind: string }).kind).toBe("leave");

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      const gid = variantGids[0];
      const salePrice = (Math.round(baseline.get(gid)! * 0.7) / 100).toFixed(2);

      // The echo arrives before the run refreshes the mirror, so the mirror still holds the
      // price from before the write.
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: gid, surfaceKind: "BASE" },
        data: { livePrice: BigInt(baseline.get(gid)!) },
      });

      // Our write, carrying the compare-at the variant already had and "leave" left alone.
      await deliver(domain, productOf.get(gid)!, gid, salePrice, "99.99");

      expect(
        await prisma.driftEvent.count({ where: { shopId, variantGid: gid } }),
        "Anchor's own write was reported as merchant drift",
      ).toBe(0);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");

      // The control: a price nobody here wrote is still drift, and still holds.
      await deliver(domain, productOf.get(gid)!, gid, "1.23", "99.99");
      expect(await prisma.driftEvent.count({ where: { shopId, variantGid: gid } })).toBe(1);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("HELD");
    });
  });
});
