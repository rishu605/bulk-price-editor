/**
 * The order a plan's variants come in (#769): title as displayed, then variant id.
 *
 * The full preview pages through a fresh plan per page, so this order is what decides
 * whether its pages add up to the scope. The database chaos scenario `preview-order`
 * pages through a real one; these pin the comparator's own promises.
 */

import { describe, expect, it } from "vitest";

import { compareVariants, inVariantOrder } from "./candidate-order";

const v = (variantGid: string, title?: string | null) => ({ variantGid, title });

describe("the order a plan's variants come in", () => {
  it("is by title, keeping a product's variants together", () => {
    const sorted = inVariantOrder([
      v("gid://shopify/ProductVariant/1", "Summit Jacket · M"),
      v("gid://shopify/ProductVariant/2", "Alpine Boots · L"),
      v("gid://shopify/ProductVariant/3", "Summit Jacket · L"),
      v("gid://shopify/ProductVariant/4", "Alpine Boots · M"),
    ]);

    expect(sorted.map((row) => row.title)).toEqual([
      "Alpine Boots · L",
      "Alpine Boots · M",
      "Summit Jacket · L",
      "Summit Jacket · M",
    ]);
  });

  it("reads numbers and case the way a person does", () => {
    const sorted = inVariantOrder([
      v("a", "Boots 12"),
      v("b", "zebra print"),
      v("c", "Boots 2"),
      v("d", "alpine"),
    ]);

    // A byte comparison gives "Boots 12", "Boots 2", "alpine", "zebra print".
    expect(sorted.map((row) => row.title)).toEqual(["alpine", "Boots 2", "Boots 12", "zebra print"]);
  });

  it("breaks a shared title by variant id, so no two variants ever tie", () => {
    const a = v("gid://shopify/ProductVariant/100", "Cascade Gloves · M");
    const b = v("gid://shopify/ProductVariant/200", "Cascade Gloves · M");

    expect(compareVariants(a, b)).toBeLessThan(0);
    expect(compareVariants(b, a)).toBeGreaterThan(0);
    expect(compareVariants(a, a)).toBe(0);
    expect(inVariantOrder([b, a])).toEqual([a, b]);
  });

  it("sorts an untitled variant by the id the preview shows in its place", () => {
    const untitled = v("gid://shopify/ProductVariant/9", null);
    const sorted = inVariantOrder([v("x", "zip"), untitled, v("y", "anorak")]);

    // "anorak" < "gid://…" < "zip": filed under what the row displays, not first or last.
    expect(sorted.map((row) => row.variantGid)).toEqual(["y", untitled.variantGid, "x"]);
  });

  it("gives the same order whatever order the rows arrive in", () => {
    const rows = [
      v("g3", "Tent"),
      v("g1", "Tent"),
      v("g2", "Pack"),
      v("g5", null),
      v("g4", "pack"),
      v("g6", "Tent 10"),
      v("g7", "Tent 9"),
    ];
    const once = inVariantOrder(rows).map((row) => row.variantGid);

    // Every rotation and the reverse: a sync rewriting rows changes the order Postgres
    // returns them in, and must not change the order a merchant pages through.
    for (let shift = 0; shift < rows.length; shift++) {
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)];
      expect(inVariantOrder(rotated).map((row) => row.variantGid)).toEqual(once);
      expect(inVariantOrder(rotated.reverse()).map((row) => row.variantGid)).toEqual(once);
    }
  });

  it("leaves the rows it was given alone", () => {
    const rows = [v("b", "B"), v("a", "A")];
    inVariantOrder(rows);
    expect(rows.map((row) => row.variantGid)).toEqual(["b", "a"]);
  });
});
