/**
 * What the picker admits to when it cannot show everything.
 *
 * `facets` caps each list at a hundred values, and always has. What it never did was say
 * so — a merchant with 412 tags saw the first hundred alphabetically, and the tag they
 * were looking for was absent in a way indistinguishable from the app not knowing it
 * existed. The cap is right; the silence was not.
 *
 * The query half is exercised against a real Postgres by `reconciliation.chaos.ts`'s
 * fixtures and by `npm run measure:queries`; what is worth pinning here is the arithmetic
 * around the boundary, because "showing 100 of 100" is as wrong as no message at all and
 * off-by-one is exactly where a cap goes wrong.
 */

import { describe, expect, it } from "vitest";

import {
  facetDetails,
  MAX_FACET_VALUES,
  truncatedFacets,
  type Facets,
} from "./facets";

const facets = (totals: Partial<Facets["totals"]> = {}): Facets => ({
  vendors: [],
  productTypes: [],
  tags: [],
  collections: [],
  totals: { vendors: 0, productTypes: 0, tags: 0, collections: 0, ...totals },
});

describe("the note under a capped picker", () => {
  it("says how many are hidden and what to do instead", () => {
    const details = facetDetails(412, "tags");

    expect(details).toContain(String(MAX_FACET_VALUES));
    expect(details).toContain("412");
    // Naming the way out matters as much as naming the problem — the error taxonomy in
    // RFC §11 asks every merchant-visible message for a next action.
    expect(details).toContain("Narrow the scope");
  });

  it("says nothing when everything fits", () => {
    // Undefined rather than "", so `details` renders no help text at all. An empty string
    // still occupies the slot under the field.
    expect(facetDetails(18, "tags")).toBeUndefined();
  });

  it("says nothing at exactly the cap, because nothing is hidden there", () => {
    expect(facetDetails(MAX_FACET_VALUES, "tags")).toBeUndefined();
  });

  it("speaks up at one past the cap", () => {
    expect(facetDetails(MAX_FACET_VALUES + 1, "tags")).toContain("101");
  });

  it("says nothing for a shop with none of that facet", () => {
    expect(facetDetails(0, "vendors")).toBeUndefined();
  });
});

describe("which facets are truncated", () => {
  it("names only the ones over the cap", () => {
    expect(
      truncatedFacets(facets({ tags: 412, vendors: 3, collections: MAX_FACET_VALUES })),
    ).toEqual(["tags"]);
  });

  it("names several", () => {
    const truncated = truncatedFacets(facets({ tags: 412, collections: 900 }));

    expect(new Set(truncated)).toEqual(new Set(["tags", "collections"]));
  });

  it("names none for a shop inside the cap everywhere", () => {
    expect(truncatedFacets(facets({ vendors: 10, productTypes: 8, tags: 18 }))).toEqual([]);
  });

  it("covers every facet the type declares", () => {
    // A fifth facet added to `totals` and not to the picker would otherwise be capped in
    // silence — the bug this file exists for, one facet along.
    const everything = facets({
      vendors: 101,
      productTypes: 101,
      tags: 101,
      collections: 101,
    });

    expect(truncatedFacets(everything)).toHaveLength(
      Object.keys(everything.totals).length,
    );
  });
});
