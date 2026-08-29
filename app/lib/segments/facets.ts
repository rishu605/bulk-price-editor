/**
 * The scope picker's option lists, and what a field says when it cannot show them all.
 *
 * Pure, and deliberately not in `segments.server`. Three routes render these notes inside
 * components rather than in a loader, and anything reached from a `*.server.ts` file is
 * stripped from the client bundle -- which the build rejects outright and typecheck does
 * not. The queries that fill these lists stay on the server; the arithmetic about them
 * belongs where both halves of the app can see it.
 */

/**
 * How many values a picker offers before it stops listing them.
 *
 * An `s-select` with four thousand options is not a picker. The cap is old; what is new
 * is that `facets` reports the true total alongside it, so a field can admit to the cap
 * rather than quietly omitting the tag somebody is looking for.
 */
export const MAX_FACET_VALUES = 100;

export interface FacetTotals {
  vendors: number;
  productTypes: number;
  tags: number;
  collections: number;
}

export interface Facets {
  vendors: string[];
  productTypes: string[];
  tags: string[];
  collections: string[];
  /**
   * How many distinct values each facet actually has, capped list or not.
   *
   * So a field showing 100 of 412 tags can say so. Silently showing the first hundred is
   * indistinguishable, to the merchant looking for the hundred-and-first, from the app
   * not knowing that tag exists.
   */
  totals: FacetTotals;
}

/** Which facets have more values than the picker will list. */
export function truncatedFacets(facets: Facets): Array<keyof FacetTotals> {
  return (Object.keys(facets.totals) as Array<keyof FacetTotals>).filter(
    (facet) => facets.totals[facet] > MAX_FACET_VALUES,
  );
}

/**
 * What a picker says under itself when it cannot show everything.
 *
 * Returns undefined rather than an empty string when there is nothing to say, so the
 * caller passes it straight to `details` and an untruncated field renders no help text at
 * all rather than a blank line under it.
 *
 * Names the way out as well as the problem, which is what the error taxonomy in RFC §11
 * asks of every merchant-visible message.
 */
export function facetDetails(total: number, noun: string): string | undefined {
  return total > MAX_FACET_VALUES
    ? `Showing ${MAX_FACET_VALUES} of ${total} ${noun}. Narrow the scope another way to reach the rest.`
    : undefined;
}
