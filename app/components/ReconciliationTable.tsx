import { Link } from "react-router";

import type { ReconciliationRow } from "../services/reconciliation.server";
import { describeState } from "../lib/reporting/reconciliation-csv";

/**
 * Every price, next to the reason it is that price.
 *
 * The controlling campaign is a link rather than a name because the next question is
 * always "and what does that campaign do?", and the answer is one click away.
 *
 * Rows are variant × surface. A variant selling in four markets is four rows, which
 * looks repetitive until the day the base price reverted and the Japanese one did not —
 * the case a collapsed view could not show at all.
 */
export function ReconciliationTable({ rows }: { rows: ReconciliationRow[] }) {
  if (rows.length === 0) {
    return (
      <s-paragraph>
        Nothing matches these filters. If you were looking for drifted prices, that is
        good news.
      </s-paragraph>
    );
  }

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Product</s-table-header>
        <s-table-header>Surface</s-table-header>
        <s-table-header>Live</s-table-header>
        <s-table-header>Baseline</s-table-header>
        <s-table-header>Because of</s-table-header>
        <s-table-header>State</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={`${row.variantGid}-${row.priceListGid}`}>
            <s-table-cell>
              <s-link href={row.adminUrl} target="_blank">
                {row.title}
              </s-link>
            </s-table-cell>
            <s-table-cell>{row.surface}</s-table-cell>
            <s-table-cell>{row.live ?? "—"}</s-table-cell>
            <s-table-cell>{row.baseline ?? "—"}</s-table-cell>
            <s-table-cell>
              {row.campaignId ? (
                <Link to={`/app/campaigns/${row.campaignId}`}>{row.campaignName}</Link>
              ) : (
                "—"
              )}
            </s-table-cell>
            <s-table-cell>
              <s-badge tone={row.drifted ? "critical" : row.offBaseline ? "info" : "success"}>
                {describeState(row)}
              </s-badge>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
