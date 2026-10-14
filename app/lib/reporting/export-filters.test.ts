/**
 * The filters a page reads from its URL, shared with its export (#819).
 */

import { describe, expect, it } from "vitest";

import { BASELINE_SOURCES } from "../baselines/sources";
import { BASE_SURFACE, baselineFiltersFrom, reconciliationFiltersFrom } from "./export-filters";

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

describe("the baselines page's Source filter (#747)", () => {
  // `source` is an enum column. `?source=hacked` used to reach the query as typed and the
  // page reported that Shopify had rejected a change.
  const source = (typed: string) => baselineFiltersFrom(new URLSearchParams({ source: typed })).source;

  it("reads a source the page offers, in any case", () => {
    expect(source("CSV_IMPORT")).toBe("CSV_IMPORT");
    expect(source("csv_import")).toBe("CSV_IMPORT");
    expect(source(" Recapture ")).toBe("RECAPTURE");
  });

  it.each(["hacked", "<script>", "CSV", ""])("treats %j as no filter, so every baseline shows", (typed) => {
    expect(source(typed)).toBeUndefined();
  });

  it("accepts every source the page offers", () => {
    for (const name of BASELINE_SOURCES) expect(source(name)).toBe(name);
  });
});
