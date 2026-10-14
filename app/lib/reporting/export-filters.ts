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

export function reconciliationFiltersFrom(params: URLSearchParams): ReconciliationFilters {
  const state = params.get("state") ?? "";
  return {
    q: params.get("q") ?? undefined,
    priceListGid: params.get("surface") ?? undefined,
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

export function activityFiltersFrom(params: URLSearchParams, timeZone: string): ActivityFilters {
  return {
    actor: params.get("actor") ?? undefined,
    action: params.get("action") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    timeZone,
  };
}

/** The page's own query, minus its page number: what its export link carries. */
export function exportQuery(params: URLSearchParams): string {
  const copy = new URLSearchParams(params);
  copy.delete("page");
  const query = copy.toString();
  return query ? `?${query}` : "";
}
