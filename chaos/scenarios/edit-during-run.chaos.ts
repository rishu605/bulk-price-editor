/**
 * A merchant's price edit made while a run is still going stays in the mirror when the run
 * settles (#1106).
 *
 * A run settles its prices in the mirror once, at its end (`settleMirror`). A sync-path run
 * on a large catalogue takes minutes and a bulk one can take an hour, and a products webhook
 * for an edit the merchant makes in that window is newer than the mirror, so it is applied.
 * The campaign is still Applying, so no drift is recorded either. Settling then wrote the
 * ledger's price over the edit, at the edit's stamp: What's live showed the sale price for a
 * variant whose live price was the merchant's, and a redelivery of the edit, being no newer,
 * was skipped.
 *
 * Settling now asks the question the webhook and both syncs ask (#1087), with the run's
 * write standing in for the read: is the mirror's row newer than it?
 *
 * Driven through the real run and the real products webhook. The edit is made in the fake
 * store and delivered after the run has written and read back the variant, and before it
 * settles: the client the run is given makes the edit once the read-back (sync) or the
 * finished bulk operation (bulk) has been answered.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { isBulkPoll, isReadBack, isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

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

/** The merchant's edit to one variant in Shopify, and the products webhook it sends. */
async function editInShopify(chaos: ChaosContext, variantGid: string, price: string): Promise<string> {
  // A later second on the store's clock than the run's write, as any edit a person makes
  // after a run has written is.
  chaos.fake.storeClockSkewMs += 2_000;
  const stamp = chaos.fake.storeNow();
  const productGid = chaos.fixture.productOf.get(variantGid)!;
  chaos.fake.variants.get(variantGid)!.price = price;
  chaos.fake.products.get(productGid)!.updatedAt = stamp;

  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: productGid,
      title: "Edited product",
      status: "active",
      tags: "chaos",
      updated_at: stamp,
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
  return stamp;
}

const isBulkWrite = (query: string) => query.includes("bulkOperationRunMutation");

/**
 * The run's client, which makes `edit` once the run has written and then heard back: the
 * read-back of a sync write, or a bulk operation reported finished. Before the write would
 * be an edit the run then overwrote in Shopify, which is not this.
 */
function editingAfterWrite(client: AdminClient, edit: () => Promise<unknown>): AdminClient {
  let written = false;
  let edited = false;
  return {
    async request<T>(query: string, variables: Record<string, unknown>) {
      const answer = await client.request<T>(query, variables);
      if (isVariantWrite(query) || isBulkWrite(query)) written = true;
      const heardBack = isReadBack(query) || (isBulkPoll(query) && JSON.stringify(answer).includes('"COMPLETED"'));
      if (written && !edited && heardBack) {
        edited = true;
        await edit();
      }
      return answer;
    },
  };
}

/** What the mirror holds for a variant on the base surface. */
async function mirrored(shopId: string, variantGid: string) {
  const index = await prisma.variantIndex.findUniqueOrThrow({ where: { shopId_variantGid: { shopId, variantGid } } });
  const surface = await prisma.priceSurfaceEntry.findUniqueOrThrow({
    where: { shopId_variantGid_surfaceKind_priceListGid: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" } },
  });
  return { price: index.price, livePrice: surface.livePrice, remoteUpdatedAt: index.remoteUpdatedAt?.toISOString() };
}

for (const path of ["sync", "bulk"] as const) {
  describe(`chaos: a price edited in Shopify while a ${path} run is going`, () => {
    it("is still in the mirror after the run settles, and the variant nobody edited is settled to the run's price", async () => {
      await withChaos(`edit-during-run-${path}`, { catalog: { products: 2, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        const [edited, untouched] = variantGids;

        let stamp = "";
        const client = editingAfterWrite(chaosAdminClient(chaos.server.endpoint()), async () => {
          stamp = await editInShopify(chaos, edited, "1.23");
        });
        const applied = await runCampaign(shopId, campaignId, client, { actor: "chaos", verifySampleRate: 1, forcePath: path });
        expect(stamp, "the edit was never made: the run was not heard back from after its write").not.toBe("");

        const write = await prisma.variantChange.findFirstOrThrow({ where: { runId: applied.runId, variantGid: edited } });
        expect(write.status, "the edit landed before the run had read its write back").toBe("VERIFIED");

        expect(await mirrored(shopId, edited), "settling the run put the sale price back over the merchant's edit").toEqual({
          price: 123n,
          livePrice: 123n,
          remoteUpdatedAt: new Date(stamp).toISOString(),
        });

        const sale = await prisma.variantChange.findFirstOrThrow({ where: { runId: applied.runId, variantGid: untouched } });
        expect(sale.status).toBe("VERIFIED");
        const settled = await mirrored(shopId, untouched);
        expect(settled.price, "a variant nobody edited was not settled to the run's price").toBe(sale.intendedPrice);
        expect(settled.livePrice).toBe(sale.intendedPrice);
        expect(chaos.fake.priceOf(untouched)).toBe((Number(sale.intendedPrice) / 100).toFixed(2));
      });
    });
  });
}
