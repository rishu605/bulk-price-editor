/**
 * A free item stays free, and a clamped price is recorded as clamped (#792).
 *
 * "10% off" on a store with no guardrails wrote $0.01 on thirteen free products: the rule
 * that no price reaches zero (E10) raised them, the Apply dialog called it a guardrail,
 * and the ledger recorded the rows as VERIFIED -- the rule's own price, apparently.
 *
 * The catalogue is three variants under "$5 off": one free, one at $3.00 (which $5 off
 * takes below zero), one ordinary. Edits arrive through the products webhook, as they
 * really do; only `authenticate.webhook` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { uncontrolledAmong } from "../../app/services/reconciliation.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const webhookAdmin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

/** A merchant's edit in the Shopify admin: the store changes, then the webhook lands. */
async function merchantEdits(chaos: ChaosContext, variantGid: string, price: string) {
  chaos.fake.variants.get(variantGid)!.price = price;
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin: webhookAdmin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Edited product",
      status: "active",
      tags: "chaos",
      updated_at: new Date(Date.now() + 120_000).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

/** Sets one variant's normal price everywhere the fixture recorded it. */
async function priceAt(chaos: ChaosContext, variantGid: string, minor: number) {
  const { shopId } = chaos.fixture;
  chaos.fake.variants.get(variantGid)!.price = (minor / 100).toFixed(2);
  chaos.fixture.baseline.set(variantGid, minor);
  await prisma.baseline.updateMany({ where: { shopId, variantGid, supersededAt: null }, data: { basePrice: BigInt(minor) } });
  await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid, surfaceKind: "BASE" }, data: { livePrice: BigInt(minor) } });
}

describe("chaos: $5 off a free item, a $3 item and a $50 one, with no guardrails", () => {
  it("leaves the free one free, records the clamp as one, and still sees edits to it", async () => {
    await withChaos("free-items", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [free, cheap, ordinary] = variantGids;
      await priceAt(chaos, free, 0);
      await priceAt(chaos, cheap, 300);
      await priceAt(chaos, ordinary, 5_000);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { ruleRows: [{ segmentIds: [], rule: { kind: "fixed-change", amount: { amount: -500, currency: "USD" } } }] as never },
      });

      const outcome = await chaos.apply();
      // The verdict reads every landed row back against the store, CLAMPED included.
      await chaos.expectHonest(outcome.runId);

      expect(chaos.fake.priceOf(free), "a free product was given a price").toBe("0.00");
      expect(chaos.fake.priceOf(cheap)).toBe("0.01");
      expect(chaos.fake.priceOf(ordinary)).toBe("45.00");

      const ledger = new Map(
        (await prisma.variantChange.findMany({ where: { runId: outcome.runId, surfaceKind: "BASE" } })).map((row) => [row.variantGid, row]),
      );
      expect(ledger.has(free), "the free product was written").toBe(false);
      expect(ledger.get(cheap)).toMatchObject({ status: "CLAMPED", intendedPrice: 1n });
      expect(ledger.get(cheap)!.failureReason).toMatch(/smallest price: the rule would have priced it at zero or below/);
      expect(ledger.get(ordinary)?.status).toBe("VERIFIED");
      expect(outcome.clean, "a clamped row is a clean write").toBe(true);

      // Reconciliation still knows the campaign put that price there.
      expect(await uncontrolledAmong(shopId, [cheap]), "the clamped price read as nobody's").toBe(0);

      // And a merchant's later edit to it is still seen: drift finds the campaign that
      // controls the variant from its landed rows, and a VERIFIED-only query found none.
      await merchantEdits(chaos, cheap, "2.00");
      const drift = await prisma.driftEvent.findFirst({ where: { shopId, variantGid: cheap, resolution: "PENDING" } });
      expect(drift, "an edit over a clamped price went unnoticed").not.toBeNull();
    });
  });
});
