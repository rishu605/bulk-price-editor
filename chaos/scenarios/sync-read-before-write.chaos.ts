/**
 * A catalogue sync that read a product before a campaign wrote its price, and saves what it
 * read after the campaign has settled that write (#1087).
 *
 * The bulk sync reads the whole catalogue into Shopify's result file and writes nothing until
 * the file is done, which on a large store is minutes. A campaign run that finishes inside
 * that window records its prices in the mirror (`settleMirror`). The sync then wrote every
 * row of its file unconditionally, so the pre-sale price went back into the mirror over the
 * campaign's, and What's live and the drift queue read it until the next webhook or sync.
 * The paginated sync did the same with a window of one page. Since #1081 a sync started
 * beside a campaign's bulk update reads in bulk too, where a 100,000-price update finishing
 * during the read is ordinary.
 *
 * The products webhook already refused a delivery older than the mirror (#828, #985). The
 * syncs now decide by the same rule: the product's `updatedAt` in what was read, against
 * the row's `remoteUpdatedAt`. And a row nobody wrote since the read is still brought up to
 * it, since correcting a stale mirror is what a sync is for.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import type { GraphQLRunner } from "../../app/services/catalog-sync.server";
import { syncCatalog } from "../../app/services/catalog-sync.server";
import { syncCatalogViaBulk } from "../../app/services/catalog-bulk-sync.server";
import type { FakeShopify } from "../harness/fake-shopify";
import { chaosAdminClient } from "../harness/http-client";
import { ledgerOf, withChaos, type ChaosContext } from "../harness/scenario";

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
  return { price: index.price, livePrice: surface.livePrice, remoteUpdatedAt: index.remoteUpdatedAt, cost: index.cost };
}

/**
 * The store before the read: every product last edited an hour ago, so the read is older
 * than the campaign's write by far more than Shopify's one-second stamp. The campaign's
 * products carry the tag it selects by, so the re-import keeps them in scope.
 *
 * The last product is one the campaign does not price, whose prices the merchant changed
 * half an hour ago without the mirror hearing of it. One of its rows was last stamped two
 * hours ago and the other never was, so both are older than the read: the sync is how the
 * mirror catches up, and it must still.
 */
interface Staged {
  /** The campaign's variants. */
  inside: string[];
  /** The rest, with the price the merchant set on each. */
  outside: Map<string, bigint>;
  /** The version of the product the read sees them at. */
  outsideStamp: string;
}

async function stage(chaos: ChaosContext): Promise<Staged> {
  const { shopId, variantGids, productOf } = chaos.fixture;
  const outsideProduct = productOf.get(variantGids[variantGids.length - 1])!;
  const inside = variantGids.filter((gid) => productOf.get(gid) !== outsideProduct);
  const outside = new Map<string, bigint>();

  for (const product of chaos.fake.products.values()) {
    product.updatedAt = storeTimeAgo(chaos.fake, 60 * MINUTE);
    if (product.productGid !== outsideProduct) chaos.fake.addMerchantTag(product.productGid, "chaos");
  }

  await prisma.variantIndex.updateMany({ where: { shopId, productGid: outsideProduct }, data: { tags: [] } });
  const outsideStamp = storeTimeAgo(chaos.fake, 30 * MINUTE);
  chaos.fake.products.get(outsideProduct)!.updatedAt = outsideStamp;
  const outsideGids = variantGids.filter((gid) => productOf.get(gid) === outsideProduct);
  outsideGids.forEach((gid, index) => {
    const price = 7_700 + index * 100;
    chaos.fake.variants.get(gid)!.price = (price / 100).toFixed(2);
    outside.set(gid, BigInt(price));
  });
  await prisma.variantIndex.update({
    where: { shopId_variantGid: { shopId, variantGid: outsideGids[0] } },
    data: { remoteUpdatedAt: new Date(Date.now() - 120 * MINUTE) },
  });

  return { inside, outside, outsideStamp };
}

/**
 * The mirror after the sync: the campaign's prices, at its write's version, where the
 * campaign wrote after the read; what the read found, at the read's version, everywhere else.
 */
async function expectMirror(chaos: ChaosContext, runId: string, { inside, outside, outsideStamp }: Staged) {
  const { shopId } = chaos.fixture;
  const ledger = await ledgerOf(runId);

  for (const variantGid of inside) {
    const write = ledger.find((row) => row.variantGid === variantGid && row.surfaceKind === "BASE");
    expect(write?.status, `${variantGid}: the campaign did not land a price to protect`).toBe("VERIFIED");
    const held = await mirrored(shopId, variantGid);
    expect(
      { price: held.price, livePrice: held.livePrice },
      `${variantGid}: the sync put the price it read before the campaign's write back in the mirror`,
    ).toEqual({ price: write!.intendedPrice, livePrice: write!.intendedPrice });
    expect(held.remoteUpdatedAt?.getTime(), `${variantGid}: the mirror's version went back to the read's`).toBe(
      write!.remoteUpdatedAt!.getTime(),
    );
  }

  for (const [variantGid, price] of outside) {
    const held = await mirrored(shopId, variantGid);
    expect(
      { price: held.price, livePrice: held.livePrice },
      `${variantGid}: the sync no longer corrects a mirror nobody wrote since its read`,
    ).toEqual({ price, livePrice: price });
    expect(held.remoteUpdatedAt?.toISOString(), `${variantGid}: the mirror does not hold the read's version`).toBe(
      new Date(outsideStamp).toISOString(),
    );
  }
}

const SPEC = { catalog: { products: 4, variantsPerProduct: 2 }, percent: -20, pollsBeforeComplete: 1_000_000 };

for (const path of ["sync", "bulk"] as const) {
  describe(`chaos: a catalogue bulk read in flight while a campaign's ${path} run settles its prices`, () => {
    it("leaves the campaign's prices in the mirror, and still corrects what the read found changed", async () => {
      await withChaos(`sync-read-before-write-${path}`, SPEC, async (chaos) => {
        const { shopId } = chaos.fixture;
        const client = chaosAdminClient(chaos.server.endpoint());
        const staged = await stage(chaos);

        // A product the mirror has never seen, so the read still creates rows.
        const fresh = `gid://shopify/ProductVariant/${chaos.seed}-fresh`;
        chaos.fake.addVariant({ variantGid: fresh, productGid: `gid://shopify/Product/${chaos.seed}-fresh`, price: "12.00", compareAtPrice: null });

        // The catalogue read: accepted, the store read, and held building its file.
        const reading = syncCatalogViaBulk(client, shopId, "USD", { pollIntervalMs: 20 });
        reading.catch(() => undefined);
        const read = await until("the catalogue read to be accepted", () =>
          prisma.bulkOperationRecord.findFirst({ where: { shopId, kind: "QUERY" } }),
        );

        // The campaign runs to the end meanwhile, and settles its prices in the mirror.
        chaos.fake.pollsBeforeComplete = 1;
        const applied = await chaos.apply({ forcePath: path });
        await chaos.expectHonest(applied.runId);
        expect(applied.clean).toBe(true);

        // Not vacuous: the read is still out, and the mirror holds the campaign's prices.
        const pending = await prisma.bulkOperationRecord.findUniqueOrThrow({ where: { id: read.id } });
        expect(pending.status, "the read finished before the campaign settled").not.toBe("COMPLETED");
        for (const variantGid of staged.inside) {
          const held = await mirrored(shopId, variantGid);
          expect(held.price, `${variantGid}: the campaign's price is not in the mirror to protect`).not.toBe(
            BigInt(chaos.fixture.baseline.get(variantGid)!),
          );
        }

        // Shopify finishes the file, which shows the prices from before the campaign.
        chaos.fake.finishBulkOnNextPoll();
        const done = await reading;
        expect(done.errors).toEqual([]);
        expect(done.variants, "the read did not carry every variant").toBe(chaos.fixture.variantGids.length + 1);
        expect(done.written).toBe(chaos.fixture.variantGids.length + 1);

        await expectMirror(chaos, applied.runId, staged);
        expect(done.kept, "the sync did not count the rows it kept").toBe(staged.inside.length);
        const created = await mirrored(shopId, fresh);
        expect({ price: created.price, livePrice: created.livePrice }, "the sync did not create a variant it had not seen").toEqual({
          price: 1_200n,
          livePrice: 1_200n,
        });
      });
    });
  });
}

/**
 * The paginated sync's catalogue, served from the fake store: its products as they stand
 * when the page is read. `beforeAnswering` runs between the read and the answer, which is
 * where a campaign settles in the race this file is about.
 */
function pagedStore(fake: FakeShopify, beforeAnswering: () => Promise<void>, edit?: (node: PageProduct) => void): GraphQLRunner {
  return {
    async graphql(query: string) {
      if (!query.includes("AnchorCatalogPage")) throw new Error(`The paged store does not serve: ${query.slice(0, 80)}`);
      const nodes: PageProduct[] = [...fake.products.values()].map((product) => ({
        id: product.productGid,
        title: product.productGid,
        status: "ACTIVE",
        tags: [...product.tags],
        updatedAt: product.updatedAt,
        isGiftCard: false,
        collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        variants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [...fake.variants.values()]
            .filter((variant) => variant.productGid === product.productGid && !variant.deleted)
            .map((variant) => ({
              id: variant.variantGid,
              title: "Default Title",
              price: variant.price,
              compareAtPrice: variant.compareAtPrice,
              inventoryItem: { unitCost: { amount: "3.00", currencyCode: "USD" } },
            })),
        },
      }));
      nodes.forEach((node) => edit?.(node));
      await beforeAnswering();
      return { json: async () => ({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }) };
    },
  };
}

interface PageProduct {
  id: string;
  title: string;
  status: string;
  tags: string[];
  updatedAt: string;
  isGiftCard: boolean;
  collections: { pageInfo: { hasNextPage: boolean; endCursor: null }; nodes: never[] };
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor: null };
    nodes: Array<{
      id: string;
      title: string;
      price: string;
      compareAtPrice: string | null;
      inventoryItem: { unitCost: { amount: string; currencyCode: string } };
    }>;
  };
}

describe("chaos: a catalogue page read before a campaign's write and saved after it settles", () => {
  it("leaves the campaign's prices in the mirror, and still corrects what the page found changed", async () => {
    await withChaos("sync-page-before-write", { catalog: { products: 3, variantsPerProduct: 2 }, percent: -20 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const staged = await stage(chaos);

      let runId = "";
      const store = pagedStore(chaos.fake, async () => {
        const applied = await chaos.apply({ forcePath: "sync" });
        await chaos.expectHonest(applied.runId);
        expect(applied.clean).toBe(true);
        runId = applied.runId;
      });

      const result = await syncCatalog(store, shopId, "USD");
      expect(result.errors).toEqual([]);
      expect(result.variants).toBe(chaos.fixture.variantGids.length);

      await expectMirror(chaos, runId, staged);
      // Cost is read by the sync alone; no campaign write or webhook carries it, so the
      // read is the newest word on it even where the mirror kept the campaign's price.
      for (const variantGid of chaos.fixture.variantGids) {
        expect((await mirrored(shopId, variantGid)).cost, `${variantGid}: the sync's cost was not recorded`).toBe(300n);
      }
    });
  });

  it("skips a read from the second of the campaign's write that shows the price it replaced, and keeps an edit made in that second (#985)", async () => {
    await withChaos("sync-page-same-second", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, variantGids, baseline, productOf } = chaos.fixture;
      for (const product of chaos.fake.products.values()) chaos.fake.addMerchantTag(product.productGid, "chaos");

      const applied = await chaos.apply({ forcePath: "sync" });
      await chaos.expectHonest(applied.runId);
      const ledger = await ledgerOf(applied.runId);
      const [stale, edited] = variantGids;
      const writeOf = (gid: string) => ledger.find((row) => row.variantGid === gid && row.surfaceKind === "BASE")!;

      // Not vacuous: the mirror holds the very second the page carries, so "strictly older"
      // cannot be what skips it.
      for (const gid of variantGids) {
        expect(writeOf(gid).remoteUpdatedAt).not.toBeNull();
        expect((await mirrored(shopId, gid)).remoteUpdatedAt?.getTime()).toBe(writeOf(gid).remoteUpdatedAt!.getTime());
      }

      // A page stamped the second of each write: one shows the price the write replaced, as a
      // read taken between two calls of a product written in several would (#985); the other
      // a price the merchant set in that second, which is theirs (#932).
      const store = pagedStore(
        chaos.fake,
        async () => undefined,
        (node) => {
          const variant = node.variants.nodes[0];
          node.updatedAt = writeOf(variant.id).remoteUpdatedAt!.toISOString().replace(".000Z", "Z");
          if (variant.id === stale) variant.price = (baseline.get(stale)! / 100).toFixed(2);
          if (variant.id === edited) variant.price = "55.55";
        },
      );
      expect(productOf.get(stale)).not.toBe(productOf.get(edited));

      const result = await syncCatalog(store, shopId, "USD");
      expect(result.errors).toEqual([]);

      const kept = await mirrored(shopId, stale);
      expect({ price: kept.price, livePrice: kept.livePrice }, "the sync took a read from before our write in that second").toEqual({
        price: writeOf(stale).intendedPrice,
        livePrice: writeOf(stale).intendedPrice,
      });
      const taken = await mirrored(shopId, edited);
      expect({ price: taken.price, livePrice: taken.livePrice }, "the sync dropped the merchant's edit in that second").toEqual({
        price: 5_555n,
        livePrice: 5_555n,
      });
    });
  });
});
