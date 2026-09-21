/**
 * The names Shopify gives its own price lists, and what a merchant should see instead.
 *
 * Live on `dartmode-labs`, the campaign editor offered
 * "pricing_by_market.19853246698_1786915628 (USD)" as one of the markets a campaign can
 * price into — a checkbox that decides where a sale reaches, labelled with an internal
 * identifier.
 */

import { describe, expect, it } from "vitest";

import { priceListLabel } from "./display-name";

describe("a name a person chose", () => {
  it("is left exactly alone", () => {
    expect(priceListLabel({ name: "Anchor EUR", catalogTitle: "Europe" })).toBe("Anchor EUR");
  });

  it("is left alone even when it looks machine-made", () => {
    // A merchant may call a price list whatever they like. Second-guessing a real name
    // is worse than showing one odd one.
    expect(priceListLabel({ name: "EU_WHOLESALE_2026", catalogTitle: "Europe" })).toBe(
      "EU_WHOLESALE_2026",
    );
  });
});

describe("a name Shopify generated", () => {
  it("gives way to the market's own title", () => {
    expect(
      priceListLabel({
        name: "pricing_by_market.19853246698_1786915628",
        catalogTitle: "United States",
      }),
    ).toBe("United States");
  });

  it("drops a uuid welded onto a readable name", () => {
    expect(
      priceListLabel({
        name: "Europe pricing - c41258df-9f1a-4666-8768-bb90e196d685",
        catalogTitle: "Europe",
      }),
    ).toBe("Europe");
  });

  it("keeps the readable half when there is no catalog title", () => {
    expect(
      priceListLabel({
        name: "Japan pricing - f303024a-c406-4be7-80d8-66303b9f439f",
        catalogTitle: null,
      }),
    ).toBe("Japan pricing");
  });
});

describe("when there is nothing readable at all", () => {
  it("says what it is rather than what it is called", () => {
    expect(
      priceListLabel({ name: "pricing_by_market.19853246698_1786915628", catalogTitle: null }),
    ).toBe("A market price list");
  });

  it("tells wholesale apart from a market", () => {
    // They are different surfaces and a merchant ticking one is making a different
    // decision, so the fallback must not fold them together.
    expect(
      priceListLabel({
        name: "pricing_by_market.1_2",
        catalogTitle: null,
        surfaceKind: "B2B",
      }),
    ).toBe("A wholesale price list");
  });

  it("survives an empty name", () => {
    expect(priceListLabel({ name: "", catalogTitle: null })).toBe("A market price list");
  });
});
