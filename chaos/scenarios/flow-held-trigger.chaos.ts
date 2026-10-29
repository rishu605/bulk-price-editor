/**
 * Holding a campaign for drift fires the "Campaign held for drift" Flow trigger (#711).
 *
 * The trigger was deployed, declared and recommended by the help centre, and nothing fired
 * it: a merchant's "when a campaign is held, message the team" workflow never ran. The edit
 * arrives through the products webhook, as it really does; the trigger call is recorded.
 */

import { describe, expect, it, vi } from "vitest";

import type { TriggerHandle, TriggerPayload } from "../../app/services/flow.server";
import { withChaos } from "../harness/scenario";

const fired: Array<{ handle: TriggerHandle; payload: TriggerPayload }> = [];

vi.mock("../../app/services/flow.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/flow.server")>()),
  fireTriggerForShop: async (_shopId: string, handle: TriggerHandle, payload: TriggerPayload) => {
    fired.push({ handle, payload });
  },
}));

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

// No worker queue, so the route handles each delivery in the request -- its fallback, and
// the same `processProductsWebhook` the worker drains with (#811). REDIS_URL is set in CI's
// chaos job, so without this the route would hand the delivery to a queue nothing here
// consumes. The queued path itself is `webhook-queue.chaos.ts`'s.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

describe("chaos: a campaign held for drift", () => {
  it("fires the Campaign held trigger once, with its fields as strings", async () => {
    await withChaos("flow-held-trigger", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { domain, campaignId, variantGids, productOf } = chaos.fixture;
      await chaos.apply();
      fired.length = 0;

      const edit = async (variantGid: string, price: string, at: number) => {
        chaos.fake.variants.get(variantGid)!.price = price;
        pending = {
          shop: domain,
          topic: "PRODUCTS_UPDATE",
          admin,
          payload: {
            admin_graphql_api_id: productOf.get(variantGid)!,
            title: "Edited product",
            status: "active",
            tags: "chaos",
            updated_at: new Date(Date.now() + at).toISOString(),
            variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
            variant_gids: [{ admin_graphql_api_id: variantGid }],
          },
        };
        const { action } = await import("../../app/routes/webhooks.products");
        await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
      };

      await edit(variantGids[0], "1.23", 60_000);
      await vi.waitFor(() => expect(fired.length, "holding the campaign fired nothing").toBeGreaterThan(0));
      expect(fired).toEqual([
        { handle: "campaign-held", payload: { "campaign id": campaignId, "campaign name": expect.any(String), "products drifted": "1" } },
      ]);

      // A second edit to the campaign already held fires nothing more.
      await edit(variantGids[1], "2.34", 120_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fired).toHaveLength(1);
    });
  });
});
