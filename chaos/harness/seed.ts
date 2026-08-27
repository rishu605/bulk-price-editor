/**
 * Deterministic fixtures: a shop, a catalogue, baselines and a campaign.
 *
 * Every scenario gets its own shop row, keyed by the run seed, so scenarios can run
 * concurrently against one database and a failure leaves its evidence behind under a
 * name you can find again.
 *
 * Determinism matters more here than it looks. A chaos suite whose failures cannot be
 * reproduced is a suite people learn to re-run until it passes -- which is worse than
 * having no suite, because it launders a real bug into a flake. Prices, cut points and
 * every other choice come from a seeded PRNG, and the seed is printed on failure, so
 * `CHAOS_SEED=<n> npm run test:chaos` replays the exact run.
 */

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import type { FakeShopify } from "./fake-shopify";

/** Small, fast, and identical across platforms -- mulberry32. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CatalogSpec {
  products: number;
  variantsPerProduct: number;
  currency?: string;
}

export interface Fixture {
  shopId: string;
  domain: string;
  campaignId: string;
  variantGids: string[];
  productOf: Map<string, string>;
  /** Baseline price in minor units, per variant. */
  baseline: Map<string, number>;
}

export interface SeedOptions {
  scenario: string;
  seed: number;
  fake: FakeShopify;
  catalog: CatalogSpec;
  /** Percent change the campaign applies. Negative is a discount. */
  percent?: number;
  priority?: number;
  /** Storefront tags the campaign applies while it runs. */
  tagKit?: string[];
}

const TAG = "chaos";

export async function seedFixture(options: SeedOptions): Promise<Fixture> {
  const { scenario, seed, fake, catalog } = options;
  const currency = catalog.currency ?? "USD";
  const random = seededRandom(seed);

  const domain = `chaos-${scenario}-${seed}.myshopify.com`;
  await destroyFixture(domain);

  const shop = await prisma.shop.create({
    data: {
      domain,
      // Entitled by default. These scenarios exist to test the pricing engine, not the
      // billing gates, and a fixture on the free plan would fail every market scenario
      // for a reason that has nothing to do with what it is testing. The downgrade
      // scenarios set their own tier.
      planTier: "WHOLESALE",
      subscriptionStatus: "ACTIVE",
      scopes: "write_products",
      timezone: "UTC",
      initialSyncCompletedAt: new Date(),
    },
  });

  const variantGids: string[] = [];
  const productOf = new Map<string, string>();
  const baseline = new Map<string, number>();

  for (let p = 0; p < catalog.products; p++) {
    const productGid = `gid://shopify/Product/${seed}-${p}`;

    for (let v = 0; v < catalog.variantsPerProduct; v++) {
      const variantGid = `gid://shopify/ProductVariant/${seed}-${p}-${v}`;
      // Whole dollars between $10 and $110, so a percentage change lands on a value
      // with no rounding ambiguity to argue about in the verdict.
      const minor = (10 + Math.floor(random() * 100)) * 100;

      variantGids.push(variantGid);
      productOf.set(variantGid, productGid);
      baseline.set(variantGid, minor);
      fake.addVariant({
        variantGid,
        productGid,
        price: (minor / 100).toFixed(2),
        compareAtPrice: null,
      });
    }
  }

  await prisma.variantIndex.createMany({
    data: variantGids.map((variantGid) => ({
      shopId: shop.id,
      variantGid,
      productGid: productOf.get(variantGid)!,
      title: variantGid,
      price: BigInt(baseline.get(variantGid)!),
      currency,
      status: "ACTIVE" as const,
      tags: [TAG],
    })),
  });

  await prisma.priceSurfaceEntry.createMany({
    data: variantGids.map((variantGid) => ({
      shopId: shop.id,
      variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: "",
      currency,
      livePrice: BigInt(baseline.get(variantGid)!),
    })),
  });

  await prisma.baseline.createMany({
    data: variantGids.map((variantGid) => ({
      shopId: shop.id,
      variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: "",
      currency,
      basePrice: BigInt(baseline.get(variantGid)!),
      source: "INSTALL_CAPTURE" as const,
    })),
  });

  const campaign = await createCampaign(shop.id, {
    name: `chaos/${scenario}`,
    priority: options.priority ?? 900,
    rule: { kind: "percent-change", percent: options.percent ?? -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
    tagKit: options.tagKit,
  });

  return { shopId: shop.id, domain, campaignId: campaign.id, variantGids, productOf, baseline };
}

/**
 * Removes a fixture shop and everything hanging off it.
 *
 * Scenarios clean up on success and deliberately leave the rows behind on failure,
 * because "what did the ledger actually say" is the first question anyone asks and
 * a tidy teardown is the fastest way to make it unanswerable.
 */
export async function destroyFixture(domain: string): Promise<void> {
  await prisma.shop.deleteMany({ where: { domain } });

  // Errors the app could not attribute to a shop. They have no shop to cascade from,
  // so nothing else removes them -- and they are counted by the global error rate while
  // no per-shop rate counts them. `shop-error-spike` asserts on exactly that asymmetry,
  // so three of these left behind invert its premise and it fails claiming the platform
  // is unhealthy.
  //
  // Three. Not fifty: it took exactly three, recorded while #346 was throwing, to break
  // it. Any failure that happens before `ensureShop` leaves one.
  await prisma.errorEvent.deleteMany({ where: { shopId: null } });
}
