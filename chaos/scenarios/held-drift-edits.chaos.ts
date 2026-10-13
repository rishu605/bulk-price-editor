/**
 * Edits to a held campaign's prices are recorded, every one of them (#878).
 *
 * Drift looked for a controlling campaign that was ACTIVE. A held campaign still controls
 * its variants -- its prices are live -- but it is not ACTIVE, so once the first edit held
 * it, every later edit was dropped. On boltify-apps a variant edited to $150 and then to
 * $140 left its event saying $150 while the storefront showed $140, so "Keep the change"
 * would have kept a price that was gone; an edit to another of its variants recorded
 * nothing, and the Apply dialog's count of edits it would write over missed it.
 *
 * Every edit arrives through the products webhook, as it really does. Only
 * `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { resolveDrift } from "../../app/services/drift.server";
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
      tags: "chaos",
      updated_at: new Date(Date.now() + clock).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

describe("chaos: edits to a campaign that drift has already held", () => {
  it("follows a second edit, records an edit to another variant, and tells the merchant once", async () => {
    await withChaos("held-drift-edits", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf } = chaos.fixture;
      const [first, second] = variantGids;
      const status = async () => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
      const told = () => prisma.auditLogEntry.count({ where: { shopId, action: "notification.drift", entityId: campaignId } });
      const holds = () =>
        prisma.auditLogEntry.count({ where: { shopId, entityId: campaignId, action: "campaign.transition", actor: "drift-detector" } });

      await chaos.expectHonest((await chaos.apply()).runId);

      await merchantEdits(chaos, domain, productOf.get(first)!, first, "1.50");
      expect(await status()).toBe("HELD");
      expect(await told()).toBe(1);
      const holdsAfterFirst = await holds();

      // The same variant, edited again.
      await merchantEdits(chaos, domain, productOf.get(first)!, first, "1.40");
      const events = await prisma.driftEvent.findMany({ where: { shopId, variantGid: first, resolution: "PENDING" } });
      expect(events, "a second edit opened a second event for the same variant").toHaveLength(1);
      expect(Number(events[0].observedPrice), "the event still shows a price the storefront no longer has").toBe(140);

      // Another variant of the held campaign, more than an hour after the merchant was told:
      // past the notifier's own hourly de-duplication, so only the hold can stop a repeat.
      await prisma.auditLogEntry.updateMany({
        where: { shopId, action: "notification.drift", entityId: campaignId },
        data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      await merchantEdits(chaos, domain, productOf.get(second)!, second, "2.22");
      const other = await prisma.driftEvent.findFirst({ where: { shopId, variantGid: second, resolution: "PENDING" } });
      expect(other, "an edit to another variant of the held campaign was not recorded").not.toBeNull();
      expect(other!.campaignId).toBe(campaignId);
      expect(Number(other!.observedPrice)).toBe(222);
      // What the Apply dialog counts as edits it would write over.
      expect(await prisma.driftEvent.count({ where: { shopId, campaignId, resolution: "PENDING" } })).toBe(2);

      // Held once, told once.
      expect(await status()).toBe("HELD");
      expect(await holds(), "an already-held campaign was held again").toBe(holdsAfterFirst);
      expect(await told(), "a second hold email went out for the same campaign").toBe(1);

      // "Keep the change" keeps the price the storefront shows now.
      await resolveDrift(shopId, events[0].id, "adopt", "staff@example.com");
      const kept = await prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid: first, surfaceKind: "BASE", supersededAt: null } });
      expect(Number(kept.basePrice)).toBe(140);
    });
  });

  it("holds a partial campaign whose price is edited, and leaves one that is being ended alone", async () => {
    await withChaos("held-drift-partial", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf } = chaos.fixture;
      const [first, second] = variantGids;
      const status = async () => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

      await chaos.expectHonest((await chaos.apply()).runId);

      // Partial after an apply: its verified prices are live and it is held like any other.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PARTIAL" } });
      await merchantEdits(chaos, domain, productOf.get(first)!, first, "1.50");
      expect(await status(), "an edit to a partial campaign's price went unrecorded").toBe("HELD");
      expect(await prisma.driftEvent.count({ where: { shopId, variantGid: first, resolution: "PENDING" } })).toBe(1);

      // Partial part-way through ending: it is handing its variants back, not keeping them.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PARTIAL" } });
      await prisma.campaignRun.create({
        data: { shopId, campaignId, kind: "REVERT", status: "PARTIAL", occurrenceKey: `REVERT-${Date.now()}`, startedAt: new Date() },
      });
      await merchantEdits(chaos, domain, productOf.get(second)!, second, "2.22");
      expect(await prisma.driftEvent.count({ where: { shopId, variantGid: second } }), "an ending campaign claimed an edit").toBe(0);
      expect(await status()).toBe("PARTIAL");
    });
  });
});
