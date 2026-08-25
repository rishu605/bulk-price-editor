/**
 * Reassembling bulk JSONL, without holding the file.
 *
 * Bulk output is not a tree. Products and variants arrive as separate lines joined by
 * `__parentId`, and the grouping is not guaranteed — so the interesting cases are the
 * ones where a naive implementation quietly loses rows: a variant far from its product,
 * a product with two thousand variants, a line that will not parse.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { parseCatalogJsonl, type ParseStats } from "./bulk-jsonl";

async function* lines(...items: unknown[]): AsyncGenerator<string> {
  for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item);
}

const product = (id: string, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  vendor: "Acme",
  productType: "Boots",
  status: "ACTIVE",
  tags: ["sale"],
  updatedAt: "2026-08-01T00:00:00Z",
  ...over,
});

const variant = (id: string, parent: string, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  __parentId: `gid://shopify/Product/${parent}`,
  title: "M",
  sku: `SKU-${id}`,
  price: "10.00",
  ...over,
});

async function collect(source: AsyncIterable<string>, stats?: ParseStats) {
  const rows = [];
  for await (const row of parseCatalogJsonl(source, "USD", stats)) rows.push(row);
  return rows;
}

describe("parseCatalogJsonl", () => {
  it("joins a variant to its product", async () => {
    const [row] = await collect(lines(product("1"), variant("11", "1")));

    expect(row.variantGid).toBe("gid://shopify/ProductVariant/11");
    expect(row.productGid).toBe("gid://shopify/Product/1");
    expect(row.vendor).toBe("Acme");
    expect(row.tags).toEqual(["sale"]);
    expect(row.price).toEqual(money(1_000, "USD"));
  });

  it("reads money as integer minor units, never a float", async () => {
    const [row] = await collect(
      lines(
        product("1"),
        variant("11", "1", {
          price: "19.99",
          compareAtPrice: "29.95",
          inventoryItem: { unitCost: { amount: "8.25", currencyCode: "USD" } },
        }),
      ),
    );

    expect(row.price).toEqual(money(1_999, "USD"));
    expect(row.compareAt).toEqual(money(2_995, "USD"));
    expect(row.cost).toEqual(money(825, "USD"));
  });

  it("holds a variant that arrives before its product", async () => {
    // Grouping is not guaranteed. Emitting this with null vendor and tags would be a
    // row that claims the product has none, which is worse than one that waits.
    const stats: ParseStats = { products: 0, variants: 0, orphans: 0, malformed: 0 };
    const rows = await collect(lines(variant("11", "1"), product("1")), stats);

    expect(rows).toHaveLength(1);
    expect(rows[0].vendor).toBe("Acme");
    expect(stats.orphans).toBe(0);
  });

  it("interleaves products and variants without crossing them over", async () => {
    const rows = await collect(
      lines(product("1"), variant("11", "1"), product("2"), variant("21", "2"), variant("12", "1")),
    );

    const byVariant = new Map(rows.map((r) => [r.variantGid, r.productGid]));
    expect(byVariant.get("gid://shopify/ProductVariant/12")).toBe("gid://shopify/Product/1");
    expect(byVariant.get("gid://shopify/ProductVariant/21")).toBe("gid://shopify/Product/2");
  });

  it("counts a variant whose product never arrives rather than dropping it", async () => {
    // A catalogue short by four hundred variants with no explanation is how a campaign
    // silently misses products.
    const stats: ParseStats = { products: 0, variants: 0, orphans: 0, malformed: 0 };
    const rows = await collect(lines(product("1"), variant("11", "1"), variant("99", "404")), stats);

    expect(rows).toHaveLength(1);
    expect(stats.orphans).toBe(1);
  });

  it("survives a line that will not parse", async () => {
    // A truncated write costs that row, not the other four hundred thousand.
    const stats: ParseStats = { products: 0, variants: 0, orphans: 0, malformed: 0 };
    const rows = await collect(lines(product("1"), "{not json", variant("11", "1")), stats);

    expect(rows).toHaveLength(1);
    expect(stats.malformed).toBe(1);
  });

  it("imports a 2,048-variant product completely (E12)", async () => {
    const stats: ParseStats = { products: 0, variants: 0, orphans: 0, malformed: 0 };
    const many = [product("big"), ...Array.from({ length: 2_048 }, (_, i) => variant(`v${i}`, "big"))];
    const rows = await collect(lines(...many), stats);

    expect(rows).toHaveLength(2_048);
    expect(stats.variants).toBe(2_048);
    expect(new Set(rows.map((r) => r.variantGid)).size).toBe(2_048);
  });

  it("carries collections onto variants that follow them", async () => {
    const rows = await collect(
      lines(
        product("1"),
        { id: "gid://shopify/Collection/9", __parentId: "gid://shopify/Product/1" },
        variant("11", "1"),
      ),
    );

    expect(rows[0].collections).toEqual(["gid://shopify/Collection/9"]);
  });

  it("gives each row its own collections array", async () => {
    // Sharing the product's array would let a later collection line mutate rows
    // already handed to the caller and written to the database.
    const rows = await collect(
      lines(
        product("1"),
        { id: "gid://shopify/Collection/9", __parentId: "gid://shopify/Product/1" },
        variant("11", "1"),
        { id: "gid://shopify/Collection/10", __parentId: "gid://shopify/Product/1" },
        variant("12", "1"),
      ),
    );

    expect(rows[0].collections).toEqual(["gid://shopify/Collection/9"]);
    expect(rows[1].collections).toEqual([
      "gid://shopify/Collection/9",
      "gid://shopify/Collection/10",
    ]);
  });

  it("prefers a meaningful variant title and ignores Default Title", async () => {
    // "Default Title" on its own tells a merchant nothing in a list of ten thousand.
    const [plain] = await collect(lines(product("1"), variant("11", "1", { title: "Default Title" })));
    expect(plain.title).toBe("Product 1");

    const [sized] = await collect(lines(product("1"), variant("11", "1", { title: "Large" })));
    expect(sized.title).toBe("Product 1 · Large");
  });

  it("normalises an unexpected status rather than storing it", async () => {
    const [row] = await collect(lines(product("1", { status: "SOMETHING_NEW" }), variant("11", "1")));
    expect(row.status).toBe("ACTIVE");
  });

  it("streams: rows are available before the input ends", async () => {
    // The property the whole module exists for. A parser that buffered would yield
    // nothing until the last of a few hundred megabytes had arrived.
    let ended = false;
    async function* slow() {
      yield JSON.stringify(product("1"));
      yield JSON.stringify(variant("11", "1"));
      await new Promise((r) => setTimeout(r, 20));
      ended = true;
      yield JSON.stringify(variant("12", "1"));
    }

    // Records whether the input had finished at the moment each row came out. If the
    // parser buffered, every entry would be true.
    const seen: boolean[] = [];
    for await (const row of parseCatalogJsonl(slow(), "USD")) {
      expect(row.variantGid).toContain("ProductVariant");
      seen.push(ended);
    }

    expect(seen[0]).toBe(false);
    expect(seen[1]).toBe(true);
  });
});
