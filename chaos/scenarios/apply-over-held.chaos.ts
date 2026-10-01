/**
 * Applying a campaign that drift has held (#755).
 *
 * A merchant edits a price a running campaign controls; the products webhook records a
 * DriftEvent and holds the campaign. Apply was still on offer, and its run wrote the
 * campaign's price over the edit -- leaving the drift event PENDING, so the queue went on
 * asking about a price the storefront no longer showed, with "Keep the change" one click
 * from making that vanished price the baseline every later campaign computes from.
 *
 * The edit arrives through the products webhook, as it really does. Only
 * `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { pendingDrift, resolveDrift } from "../../app/services/drift.server";
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

let clock = 60_000;

/** A merchant's edit in the Shopify admin: the store changes, then the webhook lands. */
async function merchantEdits(
  chaos: { fake: { variants: Map<string, { price: string }> } },
  shop: string,
  productGid: string,
  variantGid: string,
  price: string,
) {
  chaos.fake.variants.get(variantGid)!.price = price;
  clock += 60_000;
  pending = {
    shop,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: productGid,
      title: "Held product",
      status: "active",
      // The seeded campaign selects on this tag. A real edit keeps the product's tags.
      tags: "chaos",
      updated_at: new Date(Date.now() + clock).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const status = async (campaignId: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

describe("chaos: applying a campaign that drift has held", () => {
  it("closes the drift it writes over, says who did it, and stops offering to keep it", async () => {
    await withChaos("apply-over-held", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      const gid = variantGids[0];

      const applied = await chaos.apply();
      await chaos.expectHonest(applied.runId);
      const salePrice = chaos.fake.priceOf(gid)!;

      await merchantEdits(chaos, domain, productOf.get(gid)!, gid, "1.23");
      expect(await status(campaignId), "the edit did not hold the campaign").toBe("HELD");
      const [event] = await prisma.driftEvent.findMany({ where: { shopId, variantGid: gid } });
      expect(event.resolution).toBe("PENDING");

      // Apply anyway -- the button a held campaign still offers.
      const reapplied = await chaos.apply({ actor: "staff@example.com" });
      expect(chaos.fake.priceOf(gid), "the run did not write the campaign price back").toBe(salePrice);
      await chaos.expectHonest(reapplied.runId);

      const after = await prisma.driftEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.resolution, "the queue still asks about a price the storefront no longer shows").toBe(
        "REASSERTED",
      );
      expect(after.resolvedBy).toBe("staff@example.com");
      expect(after.resolvedAt).not.toBeNull();
      expect(await prisma.driftEvent.count({ where: { shopId, resolution: "PENDING" } })).toBe(0);
      expect(await pendingDrift(shopId)).toEqual([]);

      const audit = await prisma.auditLogEntry.findMany({ where: { shopId, action: "drift.overwritten" } });
      expect(audit, "nothing records that the merchant's edit was overwritten").toHaveLength(1);
      expect(audit[0].entityId).toBe(reapplied.runId);
      expect(audit[0].actor).toBe("staff@example.com");
      expect(await status(campaignId)).toBe("ACTIVE");

      // The baseline is what it was: nothing adopted the vanished $1.23.
      const row = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: gid, supersededAt: null } });
      expect(Number(row.basePrice)).toBe(baseline.get(gid));
    });
  });

  it("refuses to keep a drifted price the storefront no longer shows", async () => {
    await withChaos("adopt-gone-price", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      const gid = variantGids[0];

      await chaos.expectHonest((await chaos.apply()).runId);
      await merchantEdits(chaos, domain, productOf.get(gid)!, gid, "2.34");
      expect(await status(campaignId)).toBe("HELD");

      // The edit is then undone outside any run -- the merchant changes it again, and the
      // mirror follows. The event still describes $2.34.
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: gid, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: 345n },
      });
      const [row] = await pendingDrift(shopId);
      expect(row.stillShown, "the queue offers to keep a price that is gone").toBe(false);

      await expect(resolveDrift(shopId, row.id, "adopt", "staff@example.com")).rejects.toThrow(
        /no longer shows \$2\.34 .* it shows \$3\.45/,
      );
      const kept = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: gid, supersededAt: null } });
      expect(Number(kept.basePrice), "a vanished price became the baseline").toBe(baseline.get(gid));
      expect((await prisma.driftEvent.findUniqueOrThrow({ where: { id: row.id } })).resolution).toBe("PENDING");

      // The control: while the storefront shows it, keeping it is the merchant's call.
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: gid, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: 234n },
      });
      expect((await pendingDrift(shopId))[0].stillShown).toBe(true);
      await resolveDrift(shopId, row.id, "adopt", "staff@example.com");
      const adopted = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: gid, supersededAt: null } });
      expect(Number(adopted.basePrice)).toBe(234);
    });
  });
});
