/**
 * Generating a perf catalogue, as data rather than as a script.
 *
 * The upload needs a store; the *shapes* do not, and the shapes are the part worth being
 * sure about. A generator that quietly produced 47 variants where it claimed 50, or
 * skipped the awkward cases under some seed, would make every perf number and every
 * "handles a real catalogue" claim built on it wrong — and nobody would find out, because
 * a seeding script that runs without erroring looks like it worked.
 *
 * So this is pure and tested, and `scripts/seed-store.mjs` does nothing but upload what it
 * returns.
 *
 * **Shape matters more than count** (P0.7.4). A flat hundred thousand identical variants
 * passes tests a real catalogue fails. The distribution here deliberately includes what
 * breaks naive pricing code: variants with no cost, products with no compare-at, compare-at
 * already below price (E11), sub-major-unit prices where charm rounding once produced a
 * negative, and a wide tag spread so filter performance is realistic rather than flattering.
 */

/** Shopify's hard ceiling. The case that breaks per-product chunking assumptions. */
export const MAX_VARIANTS_PER_PRODUCT = 2_048;

export interface SeedVariant {
  optionValues: Array<{ optionName: string; name: string }>;
  price: string;
  compareAtPrice?: string;
  cost?: string;
  sku: string;
  barcode?: string;
  /**
   * Starting stock. Zero for a meaningful share, because `inventoryMin` is a targeting
   * field and a catalogue where everything is in stock never exercises it.
   */
  inventoryQty: number;
}

export interface SeedProduct {
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** Collection handles this product belongs to. See `COLLECTIONS`. */
  collections: string[];
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  variants: SeedVariant[];
}

const VENDORS = [
  "Northwind", "Aurora Supply", "Basalt Goods", "Cedar & Co", "Dovetail",
  "Ember Works", "Fjord Outfitters", "Granite Lane", "Harbourlight", "Ironwood",
];
const TYPES = ["Snowboard", "Jacket", "Gloves", "Goggles", "Boots", "Helmet", "Wax", "Backpack"];
/**
 * Tags, ordered most common first.
 *
 * The order is load-bearing: membership is drawn from a power law, so `core` lands on
 * roughly a third of products and `discontinued` on a handful. A uniform spread — which
 * is what the first version had — makes every tag equally selective, and a filter that is
 * equally selective on every value is the one case a real catalogue never presents. The
 * perf question is what happens on the tag that matches 30,000 variants, and a uniform
 * catalogue has no such tag.
 */
export const TAGS = [
  "core", "seasonal", "new", "sale", "bestseller", "premium", "bundle",
  "clearance", "outlet", "limited", "staff-pick", "final-sale", "preorder",
  "gift", "exclusive", "restock", "discontinued",
];

/**
 * Collections, ordered largest first.
 *
 * `collection` is a targeting field with a GIN index behind it, and the generator used to
 * produce none at all — so a perf number for the most-used filter in the product would
 * have been measured against zero matching rows. An index over an empty array column is
 * fast, and fast for entirely the wrong reason.
 *
 * The distribution is deliberately lopsided. "All products" holds nearly everything,
 * which is the case that decides whether collection targeting is usable at 100K variants;
 * the long tail exists so the planner is also exercised on filters that match almost
 * nothing.
 */
export const COLLECTIONS = [
  { handle: "all-products", share: 0.92 },
  { handle: "winter-2026", share: 0.34 },
  { handle: "outerwear", share: 0.21 },
  { handle: "hardgoods", share: 0.18 },
  { handle: "accessories", share: 0.12 },
  { handle: "sale-eligible", share: 0.08 },
  { handle: "new-arrivals", share: 0.04 },
  { handle: "clearance-2025", share: 0.015 },
  { handle: "pro-only", share: 0.004 },
];
const ADJECTIVES = [
  "Alpine", "Arctic", "Basecamp", "Cascade", "Drift", "Everest", "Frost",
  "Glacier", "Summit", "Tundra", "Vertex", "Whiteout",
];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const COLOURS = ["Black", "Slate", "Sand", "Moss", "Rust", "Navy", "Cream", "Ink"];

/**
 * Deterministic PRNG.
 *
 * Seeded rather than random so a re-run produces the identical catalogue — which is what
 * makes the generator idempotent, and what makes a perf number from Tuesday comparable
 * with one from Friday.
 */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export interface CatalogueOptions {
  products: number;
  /** Average variants per product. The actual count varies around it. */
  variantsPerProduct?: number;
  seed?: number;
}

/**
 * A catalogue of the requested size.
 *
 * Handles are derived from the index rather than the title, so re-running produces the
 * same handles and an idempotent seeder can skip what already exists. A handle derived
 * from a random title would create a second copy of everything on every run, which is how
 * a "100K store" quietly becomes a 400K one.
 */
export function buildCatalogue(options: CatalogueOptions): SeedProduct[] {
  const random = prng(options.seed ?? 20260817);
  const target = options.variantsPerProduct ?? 1;
  const products: SeedProduct[] = [];

  for (let index = 0; index < options.products; index++) {
    products.push(buildProduct(index, target, random));
  }

  return products;
}

function buildProduct(index: number, targetVariants: number, random: () => number): SeedProduct {
  const type = TYPES[index % TYPES.length];
  const adjective = ADJECTIVES[index % ADJECTIVES.length];

  // Varies around the target rather than sitting on it, because a catalogue where every
  // product has exactly the same variant count exercises the chunker's easy path only.
  const spread = targetVariants > 1 ? Math.round((random() - 0.5) * targetVariants * 0.6) : 0;
  const variantCount = Math.max(1, Math.min(MAX_VARIANTS_PER_PRODUCT, targetVariants + spread));

  const tags = tagsFor(random);
  const collections = COLLECTIONS.filter((collection) => random() < collection.share).map(
    (collection) => collection.handle,
  );

  return {
    handle: `anchor-perf-${index}`,
    title: `${adjective} ${type} ${index}`,
    vendor: VENDORS[index % VENDORS.length],
    productType: type,
    tags,
    collections,
    // A few draft and archived, because a catalogue of only active products never
    // exercises the filter that excludes them.
    status: index % 97 === 0 ? "ARCHIVED" : index % 41 === 0 ? "DRAFT" : "ACTIVE",
    variants: buildVariants(index, variantCount, random),
  };
}

/**
 * A product's tags, drawn from a power law.
 *
 * Squaring the draw biases it towards the front of the list, where the common tags live:
 * `core` lands on about a quarter of products and `discontinued` on about one in thirty.
 * Two to four tags each, which is what a real catalogue looks like — one broad category
 * tag and a couple of merchandising ones.
 *
 * The first version used `Math.sqrt`, which biases the other way and inverted the whole
 * list — `discontinued` on 650 products and `core` on 24. It looked like a power law in
 * every summary statistic, and every one of them was measuring the wrong tag.
 */
function tagsFor(random: () => number): string[] {
  const count = 2 + Math.floor(random() * 3);
  const tags = new Set<string>();

  while (tags.size < count) {
    tags.add(TAGS[Math.floor(random() ** 2 * TAGS.length)]);
  }

  return [...tags];
}

export function buildVariants(
  productIndex: number,
  count: number,
  random: () => number,
): SeedVariant[] {
  const variants: SeedVariant[] = [];

  for (let v = 0; v < count; v++) {
    const price = Number(priceFor(productIndex + v, random).toFixed(2));

    // A third have no compare-at; a few have one *below* price, which is invalid for a
    // strike-through and must be caught rather than written (E11).
    let compareAtPrice: string | undefined;
    const roll = random();
    if (roll > 0.66) compareAtPrice = (price * (1.1 + random() * 0.5)).toFixed(2);
    else if (roll > 0.6) compareAtPrice = (price * 0.8).toFixed(2);

    variants.push({
      optionValues: optionsFor(v, count),
      price: price.toFixed(2),
      ...(compareAtPrice ? { compareAtPrice } : {}),
      // A quarter have no cost at all — the case that makes cost-based guardrails skip
      // rather than price at zero.
      ...(random() > 0.25 ? { cost: (price * (0.3 + random() * 0.4)).toFixed(2) } : {}),
      // A fifth are out of stock and a few oversold into negative, which Shopify permits
      // and which turns a naive `inventoryQty > 0` check into a wrong answer rather than
      // an empty one.
      inventoryQty: inventoryFor(random),
      sku: `APF-${productIndex}-${v}`,
      // Most but not all, so matching has to cope with a missing barcode.
      ...(random() > 0.2 ? { barcode: String(50_000_000_000 + productIndex * 4096 + v) } : {}),
    });
  }

  return variants;
}

function inventoryFor(random: () => number): number {
  const roll = random();
  if (roll < 0.03) return -Math.ceil(random() * 5);
  if (roll < 0.22) return 0;
  return Math.ceil(random() * 400);
}

/**
 * Option values for a variant.
 *
 * Two options once a product is big enough to need them, because Shopify's ceiling is
 * reachable only by combination and a single option list of 2,048 values is not a shape
 * any real store has.
 */
export function optionsFor(index: number, total: number): Array<{ optionName: string; name: string }> {
  if (total <= SIZES.length) {
    return [{ optionName: "Size", name: SIZES[index] ?? `V${index}` }];
  }

  const colour = COLOURS[index % COLOURS.length];
  const size = SIZES[Math.floor(index / COLOURS.length) % SIZES.length];

  // The axis count comes from `total`, not from `index`. It used to come from the index —
  // an "Edition" value appeared only once colour × size ran out at variant 48 — which
  // meant the product declared three options while its first 48 variants supplied two
  // values. Shopify requires exactly one value per option and rejected every row.
  //
  // Because `productSet` runs inside a bulk operation, all Shopify reported was
  // `COMPLETED — 1 objects`. Every product over 48 variants failed in total silence, which
  // is every product in a catalogue seeded at the default fifty.
  if (total <= COLOURS.length * SIZES.length) {
    return [
      { optionName: "Colour", name: colour },
      { optionName: "Size", name: size },
    ];
  }

  const edition = Math.floor(index / (COLOURS.length * SIZES.length));

  return [
    { optionName: "Colour", name: colour },
    { optionName: "Size", name: size },
    { optionName: "Edition", name: `E${edition}` },
  ];
}

function priceFor(index: number, random: () => number): number {
  // Three bands, including sub-major-unit prices where charm rounding once produced a
  // negative value.
  if (index % 23 === 0) return 0.35 + random() * 0.64;
  if (index % 7 === 0) return 200 + random() * 1_800;
  return 5 + random() * 175;
}

/**
 * The single product at Shopify's hard ceiling.
 *
 * Its own function because it is its own test case: 2,048 variants is where per-product
 * chunking assumptions break, where a bulk query's `__parentId` reassembly is actually
 * exercised, and where "we page at 250" meets "this product is nine pages".
 */
export function buildMaxVariantProduct(seed = 20260817): SeedProduct {
  const random = prng(seed);

  return {
    handle: "anchor-perf-max-variants",
    title: "Everything Jacket (2,048 variants)",
    vendor: "Northwind",
    productType: "Jacket",
    tags: ["core", "perf"],
    // In the big collection deliberately: a collection filter that matches this product
    // matches 2,048 variants from one row, which is the shape that makes a preview's
    // "how many will this touch" count arrive late.
    collections: ["all-products", "outerwear"],
    status: "ACTIVE",
    variants: buildVariants(999_000, MAX_VARIANTS_PER_PRODUCT, random),
  };
}

export interface SeedPriceList {
  name: string;
  currency: string;
  /** Basis points against the base price. Null means it carries fixed prices instead. */
  adjustmentBps: number | null;
  /** How many variants get an explicit override on a fixed list. */
  fixedOverrides: number;
}

/**
 * The markets a perf store needs.
 *
 * JPY is here deliberately: it is zero-decimal, and it is what breaks naive rounding (E9).
 * A perf store with only USD and EUR would let a whole class of bug through while looking
 * multi-currency.
 *
 * Both kinds of list, because the read paths differ — a relative list is stored as its
 * rule and a fixed one as rows, and a store with only one kind exercises half the code.
 */
export function marketPriceLists(): SeedPriceList[] {
  return [
    { name: "United States", currency: "USD", adjustmentBps: null, fixedOverrides: 500 },
    { name: "Europe", currency: "EUR", adjustmentBps: -1_000, fixedOverrides: 0 },
    { name: "Japan", currency: "JPY", adjustmentBps: 2_000, fixedOverrides: 0 },
    { name: "Wholesale", currency: "USD", adjustmentBps: -3_000, fixedOverrides: 0 },
  ];
}
