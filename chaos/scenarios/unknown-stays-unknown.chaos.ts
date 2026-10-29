/**
 * A price a stopped run left unknown in the mirror stays unknown until something reads the
 * product after the run (#1107).
 *
 * A run that cannot vouch for a write -- written but never read back, still in flight, or
 * failed -- settles that variant's mirror price to null: "we have not looked" (#699). It
 * left the row's version where it was, from before the run. So a catalogue read that began
 * before the run, or a products webhook delayed from before the write, was not older than
 * the row by `heldIsNewer`, and filled the null with the price from before the run. What's
 * live then showed that price for a variant whose sale price may well be live.
 *
 * A read is now older than a null the mirror was given after the read began: the sync's own
 * start, or the webhook's stamp. A read from after the run still fills it with what Shopify
 * holds.
 *
 * Driven through the real run, the real catalogue bulk read and the real products webhook.
 * The run's writes land and every read-back of them fails, so each is unknown.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { syncCatalogViaBulk } from "../../app/services/catalog-bulk-sync.server";
import { isReadBack } from "../harness/faults";
import type { FakeShopify } from "../harness/fake-shopify";
import { chaosAdminClient } from "../harness/http-client";
import { ledgerOf, withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

const admin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

const MINUTE = 60_000;

/** Waits for something running in the background, or fails saying what. */
async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The store's clock `ms` ago, as Shopify stamps a product: ISO, to the second. */
function storeTimeAgo(fake: FakeShopify, ms: number): string {
  return new Date(Math.floor((Date.now() + fake.storeClockSkewMs - ms) / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** What the mirror holds for a variant on the base surface. */
async function mirrored(shopId: string, variantGid: string) {
  const index = await prisma.variantIndex.findUniqueOrThrow({ where: { shopId_variantGid: { shopId, variantGid } } });
  const surface = await prisma.priceSurfaceEntry.findUniqueOrThrow({
    where: { shopId_variantGid_surfaceKind_priceListGid: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "" } },
  });
  return { price: index.price, livePrice: surface.livePrice };
}

/** A products webhook for one variant, stamped `updatedAt` on the store's clock. */
async function deliver(chaos: ChaosContext, variantGid: string, price: string, updatedAt: string) {
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Product",
      status: "active",
      tags: "chaos",
      updated_at: updatedAt,
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const SPEC = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20, pollsBeforeComplete: 1_000_000 };

describe("chaos: a price a stopped run left unknown, and a read from before the run", () => {
  it("stays unknown after a catalogue read and a late webhook from before the write, and a read after the run fills it", async () => {
    await withChaos("unknown-stays-unknown", SPEC, async (chaos) => {
      const { shopId, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // The mirror and the store agree, at a version from an hour ago.
      const version = storeTimeAgo(chaos.fake, 60 * MINUTE);
      for (const product of chaos.fake.products.values()) product.updatedAt = version;
      await prisma.variantIndex.updateMany({ where: { shopId }, data: { remoteUpdatedAt: new Date(version) } });

      // A catalogue read, accepted before the run and held building its file.
      const reading = syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 20 });
      reading.catch(() => undefined);
      await until("the catalogue read to be accepted", () => prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "QUERY" } }));

      // The run writes every price, and cannot read one of them back.
      chaos.arm([{ fault: "network", match: (query) => isReadBack(query) }]);
      const applied = await chaos.apply({ forcePath: "sync" }).catch(() => null);
      chaos.heal();
      const runId = applied?.runId ?? (await chaos.latestRunId("APPLY"));
      const ledger = await ledgerOf(runId);

      for (const variantGid of variantGids) {
        const write = ledger.find((row) => row.variantGid === variantGid && row.surfaceKind === "BASE");
        expect(write?.status, `${variantGid}: the write was read back after all`).not.toBe("VERIFIED");
        expect(chaos.fake.priceOf(variantGid), `${variantGid}: the write did not land`).not.toBe(
          (baseline.get(variantGid)! / 100).toFixed(2),
        );
        expect(await mirrored(shopId, variantGid), `${variantGid}: the run did not leave its price unknown`).toEqual({
          price: null,
          livePrice: null,
        });
      }

      // The read finishes, showing every price from before the run.
      chaos.fake.finishBulkOnNextPoll();
      const done = await reading;
      expect(done.errors).toEqual([]);
      expect(done.written).toBe(variantGids.length);
      for (const variantGid of variantGids) {
        expect(await mirrored(shopId, variantGid), `${variantGid}: a read from before the run filled in the price from before it`).toEqual({
          price: null,
          livePrice: null,
        });
      }

      // A products webhook delayed from before the write: no newer than the read.
      const [late] = variantGids;
      await deliver(chaos, late, (baseline.get(late)! / 100).toFixed(2), storeTimeAgo(chaos.fake, 30 * MINUTE));
      expect(await mirrored(shopId, late), "a webhook from before the write filled in the price from before it").toEqual({
        price: null,
        livePrice: null,
      });

      // A read from after the run: the mirror holds what Shopify holds.
      chaos.fake.pollsBeforeComplete = 1;
      const after = await syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 20 });
      expect(after.errors).toEqual([]);
      for (const variantGid of variantGids) {
        const live = BigInt(Math.round(Number(chaos.fake.priceOf(variantGid)) * 100));
        expect(await mirrored(shopId, variantGid), `${variantGid}: a read after the run did not fill in the price`).toEqual({
          price: live,
          livePrice: live,
        });
      }
    });
  });
});
