/**
 * The shapes a perf catalogue has to contain.
 *
 * A generator that quietly produced 47 variants where it claimed 50, or skipped the
 * awkward cases under some seed, would make every perf number built on it wrong — and
 * nobody would find out, because a seeding script that runs without erroring looks like
 * it worked.
 */

import { describe, expect, it } from "vitest";

import {
  buildCatalogue,
  buildMaxVariantProduct,
  marketPriceLists,
  MAX_VARIANTS_PER_PRODUCT,
  optionsFor,
  prng,
  TAGS,
  type SeedProduct,
} from "./catalogue";

describe("determinism", () => {
  it("produces the identical catalogue for the same seed", () => {
    // What makes the seeder idempotent, and what makes Tuesday's perf number comparable
    // with Friday's.
    const a = buildCatalogue({ products: 50, variantsPerProduct: 5, seed: 7 });
    const b = buildCatalogue({ products: 50, variantsPerProduct: 5, seed: 7 });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces a different catalogue for a different seed", () => {
    const a = buildCatalogue({ products: 20, seed: 1 });
    const b = buildCatalogue({ products: 20, seed: 2 });

    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("derives handles from the index, not the title", () => {
    // A handle derived from a random title creates a second copy of everything on every
    // run, which is how a "100K store" quietly becomes a 400K one.
    const catalogue = buildCatalogue({ products: 5, seed: 3 });

    expect(catalogue.map((product) => product.handle)).toEqual([
      "anchor-perf-0",
      "anchor-perf-1",
      "anchor-perf-2",
      "anchor-perf-3",
      "anchor-perf-4",
    ]);
  });

  it("gives every variant a unique SKU across the catalogue", () => {
    // Duplicate SKUs make every import ambiguous, which would make the perf store
    // useless for testing the importers.
    const catalogue = buildCatalogue({ products: 100, variantsPerProduct: 8, seed: 11 });
    const skus = catalogue.flatMap((product) => product.variants.map((v) => v.sku));

    expect(new Set(skus).size).toBe(skus.length);
  });
});

describe("scale", () => {
  it("averages close to the requested variants per product", () => {
    const catalogue = buildCatalogue({ products: 400, variantsPerProduct: 50, seed: 5 });
    const total = catalogue.reduce((sum, product) => sum + product.variants.length, 0);
    const average = total / catalogue.length;

    expect(average).toBeGreaterThan(40);
    expect(average).toBeLessThan(60);
  });

  it("varies the count rather than sitting on it", () => {
    // A catalogue where every product has the same variant count exercises the chunker's
    // easy path only.
    const catalogue = buildCatalogue({ products: 200, variantsPerProduct: 50, seed: 5 });
    const counts = new Set(catalogue.map((product) => product.variants.length));

    expect(counts.size).toBeGreaterThan(5);
  });

  it("never exceeds Shopify's per-product ceiling", () => {
    const catalogue = buildCatalogue({ products: 100, variantsPerProduct: 3_000, seed: 5 });

    for (const product of catalogue) {
      expect(product.variants.length).toBeLessThanOrEqual(MAX_VARIANTS_PER_PRODUCT);
    }
  });
});

describe("the 2,048-variant product", () => {
  it("is exactly at the ceiling", () => {
    // Where per-product chunking assumptions break, where __parentId reassembly is
    // actually exercised, and where "we page at 250" meets "this product is nine pages".
    expect(buildMaxVariantProduct().variants).toHaveLength(MAX_VARIANTS_PER_PRODUCT);
  });

  it("gives every variant a distinct option combination", () => {
    // Shopify rejects a product with two identical option combinations, so a generator
    // that repeated them would fail at upload after generating two thousand rows.
    const product = buildMaxVariantProduct();
    const combinations = product.variants.map((variant) =>
      variant.optionValues.map((option) => `${option.optionName}:${option.name}`).join("|"),
    );

    expect(new Set(combinations).size).toBe(combinations.length);
  });

  it("uses more than one option, because 2,048 is only reachable by combination", () => {
    const product = buildMaxVariantProduct();

    expect(product.variants[100].optionValues.length).toBeGreaterThan(1);
  });
});

describe("the awkward cases (P0.7.4)", () => {
  const catalogue = buildCatalogue({ products: 500, variantsPerProduct: 4, seed: 42 });
  const variants = catalogue.flatMap((product) => product.variants);

  it("includes variants with no cost", () => {
    // The case that makes cost-based guardrails skip rather than price at zero.
    expect(variants.some((variant) => variant.cost === undefined)).toBe(true);
  });

  it("includes variants with no compare-at", () => {
    expect(variants.some((variant) => variant.compareAtPrice === undefined)).toBe(true);
  });

  it("includes compare-at already at or below price (E11)", () => {
    // Invalid for a strike-through, and the thing that must be caught rather than
    // written.
    expect(
      variants.some(
        (variant) =>
          variant.compareAtPrice !== undefined &&
          Number(variant.compareAtPrice) <= Number(variant.price),
      ),
    ).toBe(true);
  });

  it("includes sub-major-unit prices", () => {
    // Where charm rounding once produced a negative price.
    expect(variants.some((variant) => Number(variant.price) < 1)).toBe(true);
  });

  it("includes draft and archived products", () => {
    const statuses = new Set(catalogue.map((product) => product.status));

    expect(statuses.has("DRAFT")).toBe(true);
    expect(statuses.has("ARCHIVED")).toBe(true);
  });

  it("includes variants with no barcode", () => {
    expect(variants.some((variant) => variant.barcode === undefined)).toBe(true);
  });

  it("spreads tags and vendors widely enough for filter perf to mean anything", () => {
    expect(new Set(catalogue.flatMap((p) => p.tags)).size).toBeGreaterThan(5);
    expect(new Set(catalogue.map((p) => p.vendor)).size).toBeGreaterThan(5);
  });
});

describe("market price lists (P0.7.3)", () => {
  const lists = marketPriceLists();

  it("includes a zero-decimal currency", () => {
    // JPY is here deliberately: it is what breaks naive rounding (E9), and a perf store
    // with only USD and EUR would let a whole class of bug through while looking
    // multi-currency.
    expect(lists.some((list) => list.currency === "JPY")).toBe(true);
  });

  it("includes both a fixed-price list and percentage-adjusted ones", () => {
    // The read paths differ — a relative list is stored as its rule, a fixed one as rows
    // — so a store with only one kind exercises half the code.
    expect(lists.some((list) => list.adjustmentBps === null)).toBe(true);
    expect(lists.some((list) => list.adjustmentBps !== null)).toBe(true);
  });

  it("includes a market above the base price as well as below it", () => {
    // Direction matters: a percentage increase and a percentage decrease compose
    // differently with a campaign, and only testing decreases hides that.
    expect(lists.some((list) => (list.adjustmentBps ?? 0) > 0)).toBe(true);
    expect(lists.some((list) => (list.adjustmentBps ?? 0) < 0)).toBe(true);
  });
});

describe("options", () => {
  it("uses one option while sizes are enough", () => {
    expect(optionsFor(0, 4)).toEqual([{ optionName: "Size", name: "XS" }]);
  });

  it("adds a third axis once colour and size run out", () => {
    expect(optionsFor(500, 2_048).length).toBe(3);
  });
});

describe("the PRNG", () => {
  it("stays inside [0, 1)", () => {
    const random = prng(1);
    for (let i = 0; i < 10_000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("distributions that make a perf number mean something", () => {
  // Two thousand products, which is the shape the perf store is actually seeded at. A
  // smaller sample makes the rare end of each distribution a coin flip, and an assertion
  // that passes on a lucky draw is worse than no assertion.
  const products = buildCatalogue({ products: 2000, variantsPerProduct: 3 });

  const countBy = (pick: (product: SeedProduct) => string[]) => {
    const counts = new Map<string, number>();
    for (const product of products) {
      for (const value of pick(product)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };

  it("puts products in collections at all", () => {
    // The generator produced none, for as long as it existed. `collection` is a targeting
    // field with a GIN index behind it, so every perf number for the most-used filter in
    // the product would have been measured against zero matching rows — fast, and fast
    // for entirely the wrong reason.
    const counts = countBy((product) => product.collections);

    expect(counts.get("all-products")).toBeGreaterThan(1_500);
    expect(products.filter((product) => product.collections.length === 0).length)
      .toBeLessThan(products.length * 0.15);
  });

  it("skews collection membership rather than spreading it evenly", () => {
    // The question worth measuring is what happens on the collection holding 90,000
    // variants, and a catalogue where every collection is the same size has no such
    // collection. The tail matters too: a filter matching almost nothing exercises the
    // planner's empty path, which is where an off-by-one surfaces as a silent no-op.
    const counts = countBy((product) => product.collections);

    expect(counts.get("all-products")!).toBeGreaterThan(counts.get("pro-only")! * 50);
    expect(counts.get("pro-only")).toBeGreaterThan(0);
  });

  it("makes the common tags common and the rare ones rare", () => {
    // The assertion that catches the bug this test was written after. The first draft
    // drew tags with `Math.sqrt`, which biases towards the *end* of the list and
    // inverted the whole thing: `discontinued` on 650 products, `core` on 24. Every
    // summary statistic still showed a power law. It was just measuring the wrong tags.
    const counts = countBy((product) => product.tags);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    expect(ranked[0][0]).toBe(TAGS[0]);
    expect(ranked[0][1]).toBeGreaterThan(ranked[ranked.length - 1][1] * 3);
  });

  it("leaves a fifth of variants out of stock, and a few oversold", () => {
    // `inventoryMin` is a targeting field. A catalogue where everything is in stock never
    // exercises it, and one where nothing is negative lets a naive `qty > 0` check look
    // correct — Shopify permits overselling into negative, and the difference between
    // "none" and "minus three" is a campaign that skips a variant it should have priced.
    const variants = products.flatMap((product) => product.variants);

    const zero = variants.filter((variant) => variant.inventoryQty === 0).length;
    const negative = variants.filter((variant) => variant.inventoryQty < 0).length;

    expect(zero / variants.length).toBeGreaterThan(0.1);
    expect(zero / variants.length).toBeLessThan(0.35);
    expect(negative).toBeGreaterThan(0);
  });

  it("stays deterministic, so Tuesday's number is comparable with Friday's", () => {
    const again = buildCatalogue({ products: 2000, variantsPerProduct: 3 });

    expect(JSON.stringify(again)).toBe(JSON.stringify(products));
  });
});

describe("option values Shopify will accept", () => {
  /**
   * The rule: a product declares a set of options, and every variant must supply exactly
   * one value for each of them. Break it and `productSet` rejects the whole product.
   *
   * This went unnoticed because the rejection is invisible. `productSet` runs inside a
   * bulk operation, so the per-row `userErrors` land in a result file the seeder never
   * read — Shopify reported `COMPLETED — 1 objects` and the script printed it. Every
   * product over 48 variants failed in total silence, which at the default fifty is every
   * product in the catalogue.
   *
   * `total` values chosen around the boundaries: the one-option branch, either side of
   * colour × size running out at 48, and the ceiling.
   */
  for (const total of [1, 2, 6, 7, 20, 47, 48, 49, 50, 200, MAX_VARIANTS_PER_PRODUCT]) {
    it(`gives every variant one value per option at ${total} variants`, () => {
      const perVariant = Array.from({ length: total }, (_, index) => optionsFor(index, total));

      // What the product ends up declaring: the union of every option name used, which is
      // exactly how the uploader builds `productOptions`.
      const declared = new Set(perVariant.flatMap((o) => o.map((v) => v.optionName)));

      for (const options of perVariant) {
        expect(options.map((o) => o.optionName).sort()).toEqual([...declared].sort());
      }
    });

    it(`gives every variant a distinct combination at ${total} variants`, () => {
      // Shopify's other rule, and the one that decides whether 2,048 is reachable at all:
      // two variants cannot share an option combination. Three axes of 8 × 6 × 43 leaves
      // just enough room.
      const combinations = Array.from({ length: total }, (_, index) =>
        optionsFor(index, total)
          .map((option) => `${option.optionName}=${option.name}`)
          .join("/"),
      );

      expect(new Set(combinations).size).toBe(total);
    });
  }
});
