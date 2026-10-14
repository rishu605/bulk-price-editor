/**
 * The filters a page reads from its URL, shared with its export (#819).
 *
 * An export used to be the rows on screen, built in the browser. It is now a server route
 * that reads every row for the page's filters. The page and its export must agree on what
 * those filters are, so each is parsed here, once, for both.
 */

import type { ActivityFilters } from "../../services/activity.server";
import type { BaselineFilters } from "../../services/baseline-browser.server";
import type { ReconciliationFilters } from "../../services/reconciliation.server";

/**
 * The Surface filter's value for base prices (#722). The base surface's gid is "", and the
 * filter form drops an empty value from the URL -- so "Base price" submitted nothing, the
 * page applied no filter, and the select snapped back to "Every surface".
 */
export const BASE_SURFACE = "base";

export function reconciliationFiltersFrom(params: URLSearchParams): ReconciliationFilters {
  const state = params.get("state") ?? "";
  return {
    q: params.get("q") ?? undefined,
    // The base surface is submitted as a word, because its gid is "" and an empty value
    // never reaches the URL (#722).
    priceListGid: params.get("surface") === BASE_SURFACE ? "" : (params.get("surface") ?? undefined),
    campaignId: params.get("campaign") || undefined,
    driftedOnly: state === "drifted",
    offBaselineOnly: state === "off-baseline",
    staleBaselineOnly: state === "stale-baseline",
  };
}

export function baselineFiltersFrom(params: URLSearchParams): BaselineFilters {
  return {
    q: params.get("q") ?? undefined,
    vendor: params.get("vendor") ?? undefined,
    source: params.get("source") ?? undefined,
    divergedOnly: params.get("diverged") === "1",
  };
}

export function activityFiltersFrom(params: URLSearchParams): ActivityFilters {
  return {
    actor: params.get("actor") ?? undefined,
    action: params.get("action") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  };
}

/** The page's own query, minus its page number: what its export link carries. */
export function exportQuery(params: URLSearchParams): string {
  const copy = new URLSearchParams(params);
  copy.delete("page");
  const query = copy.toString();
  return query ? `?${query}` : "";
}
