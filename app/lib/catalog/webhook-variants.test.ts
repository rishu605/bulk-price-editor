/**
 * Reading which variants a product webhook says are still on the product (#729).
 */

import { describe, expect, it } from "vitest";

import { variantsStillOnProduct, WEBHOOK_VARIANT_DETAIL_LIMIT } from "./webhook-variants";

const gid = (n: number) => `gid://shopify/ProductVariant/${n}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("variants still on the product", () => {
  it("takes every id `variant_gids` lists, not only the 100 `variants` describes", () => {
    const present = variantsStillOnProduct({
      variants: range(1, 100).map((n) => ({ admin_graphql_api_id: gid(n) })),
      variant_gids: range(1, 150).map((n) => ({ admin_graphql_api_id: gid(n) })),
    });
    expect(present?.size).toBe(150);
    expect(present?.has(gid(150))).toBe(true);
  });

  it("is the union, so a `variant_gids` that lists only 101 onward loses nothing", () => {
    const present = variantsStillOnProduct({
      variants: range(1, 100).map((n) => ({ admin_graphql_api_id: gid(n) })),
      variant_gids: range(101, 150).map((n) => ({ admin_graphql_api_id: gid(n) })),
    });
    expect(present?.size).toBe(150);
  });

  it("builds an id from a numeric one, as the rest of the handler does", () => {
    expect(variantsStillOnProduct({ variants: [{ id: 7 }] })).toEqual(new Set([gid(7)]));
  });

  it("accepts bare strings in `variant_gids` rather than dropping them", () => {
    expect(variantsStillOnProduct({ variants: [], variant_gids: [gid(1), { admin_graphql_api_id: gid(2) }] })?.size).toBe(2);
  });

  it("trusts `variants` alone only below the detail limit", () => {
    const small = variantsStillOnProduct({ variants: range(1, 3).map((n) => ({ admin_graphql_api_id: gid(n) })) });
    expect(small?.size).toBe(3);

    const atLimit = variantsStillOnProduct({
      variants: range(1, WEBHOOK_VARIANT_DETAIL_LIMIT).map((n) => ({ admin_graphql_api_id: gid(n) })),
    });
    expect(atLimit, "a full page with no ids could have more behind it").toBeNull();

    const over = variantsStillOnProduct({ variants: range(1, 250).map((n) => ({ admin_graphql_api_id: gid(n) })) });
    expect(over).toBeNull();
  });

  it("cannot say anything from an empty payload", () => {
    expect(variantsStillOnProduct({})).toBeNull();
    expect(variantsStillOnProduct({ variants: [], variant_gids: [] })).toBeNull();
    expect(variantsStillOnProduct({ variants: [], variant_gids: null })).toBeNull();
  });
});
