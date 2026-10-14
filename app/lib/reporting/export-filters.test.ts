/**
 * The filters a page reads from its URL, shared with its export (#819).
 */

import { describe, expect, it } from "vitest";

import { BASE_SURFACE, reconciliationFiltersFrom } from "./export-filters";

describe("What's live's Surface filter (#722)", () => {
  it("reads the base surface as a word, since its gid is empty and an empty value never reaches the URL", () => {
    expect(reconciliationFiltersFrom(new URLSearchParams({ surface: BASE_SURFACE })).priceListGid).toBe("");
  });

  it("reads a price list by its gid, and no surface as every surface", () => {
    expect(reconciliationFiltersFrom(new URLSearchParams({ surface: "gid://shopify/PriceList/1" })).priceListGid).toBe(
      "gid://shopify/PriceList/1",
    );
    expect(reconciliationFiltersFrom(new URLSearchParams()).priceListGid).toBeUndefined();
  });
});
