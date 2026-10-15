/**
 * A single-variant product synced by webhook is titled as the bulk sync titles it (#782).
 *
 * The products webhook stored "QA Recapture Board · Default Title", where the bulk sync
 * stored "QA Recapture Board", and the suffix followed the variant into the preview, the
 * Apply dialog, the ledger and the revert report.
 *
 * Through the products webhook's own action.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const webhookAdmin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

describe("chaos: a product with no options, synced by webhook", () => {
  it("is titled with the product's name alone", async () => {
    await withChaos("webhook-default-title", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      const productGid = "gid://shopify/Product/default-title";
      const variantGid = "gid://shopify/ProductVariant/default-title";
      pending = {
        shop: domain,
        topic: "PRODUCTS_CREATE",
        admin: webhookAdmin,
        payload: {
          admin_graphql_api_id: productGid,
          title: "QA Recapture Board",
          status: "active",
          tags: "",
          updated_at: new Date().toISOString(),
          variants: [{ admin_graphql_api_id: variantGid, title: "Default Title", price: "100.00", compare_at_price: null }],
          variant_gids: [{ admin_graphql_api_id: variantGid }],
        },
      };
      const { action } = await import("../../app/routes/webhooks.products");
      await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);

      const row = await prisma.variantIndex.findFirst({ where: { shopId, variantGid } });
      expect(row, "the webhook did not store the variant").not.toBeNull();
      expect(row!.title).toBe("QA Recapture Board");
    });
  });
});
