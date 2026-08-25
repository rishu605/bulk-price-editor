/**
 * The link that replaces a shrug.
 *
 * "Why is this variant priced the way it is?" arrives in support tickets constantly for
 * competitors, and their answer is usually a guess. The part worth testing without a
 * database is the one that decides where support lands when they do have to leave the
 * page.
 */

import { describe, expect, it } from "vitest";

import { adminProductUrl } from "./baseline-browser.server";

describe("adminProductUrl", () => {
  it("links to the product, not a search box", () => {
    expect(adminProductUrl("dartmode-labs.myshopify.com", "gid://shopify/Product/12345")).toBe(
      "https://admin.shopify.com/store/dartmode-labs/products/12345",
    );
  });

  it("copes with a domain that already lacks the suffix", () => {
    expect(adminProductUrl("dartmode-labs", "gid://shopify/Product/1")).toBe(
      "https://admin.shopify.com/store/dartmode-labs/products/1",
    );
  });

  it("produces a store link rather than a broken one when the gid is odd", () => {
    // A malformed gid should not render a link to nowhere with a stray slash — it
    // should land on the store and let somebody search.
    expect(adminProductUrl("shop.myshopify.com", "")).toBe(
      "https://admin.shopify.com/store/shop/products/",
    );
  });
});
