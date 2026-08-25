/**
 * Which surface a price list belongs to.
 *
 * Codegen made this worth a test. The hand-written type said a catalog was a market
 * catalog or a company-location one; the schema says there is a third kind owned by
 * another app, and a two-way check files it under MARKET — which would mirror somebody
 * else's surface and then invite a campaign to write prices into it.
 */

import { describe, expect, it } from "vitest";

import { surfaceKindOf } from "./markets-sync.server";

describe("surfaceKindOf", () => {
  it("maps a market catalog to the market surface", () => {
    expect(surfaceKindOf({ __typename: "MarketCatalog" })).toBe("MARKET");
  });

  it("maps a company-location catalog to B2B", () => {
    expect(surfaceKindOf({ __typename: "CompanyLocationCatalog" })).toBe("B2B");
  });

  it("treats a list with no catalog as B2B", () => {
    // Attached to companies rather than to a market, which is how a B2B price list
    // presents on the real store.
    expect(surfaceKindOf(null)).toBe("B2B");
    expect(surfaceKindOf(undefined)).toBe("B2B");
  });

  it("refuses an app-owned catalog rather than calling it a market", () => {
    expect(surfaceKindOf({ __typename: "AppCatalog" })).toBeNull();
  });

  it("refuses a catalog kind it does not recognise", () => {
    // Guessing which surface an unfamiliar catalog is means guessing where prices go.
    expect(surfaceKindOf({ __typename: "SomethingShopifyAddedLater" })).toBeNull();
    expect(surfaceKindOf({})).toBeNull();
  });
});
