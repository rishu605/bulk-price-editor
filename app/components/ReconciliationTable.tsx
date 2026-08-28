import type { ReconciliationRow } from "../services/reconciliation.server";
import { stateLabel } from "../lib/reporting/reconciliation-csv";

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
      {/* Rows are variant x surface, so the same product name appears once per market
          it sells in. The surface is a kicker for that reason: it is the qualifier that
          tells two otherwise identical rows apart, and it has to be read before the name
          rather than found in a labelled pair underneath it. */}
      <s-table-header-row>
        <s-table-header listSlot="kicker">Surface</s-table-header>
        <s-table-header listSlot="primary">Product</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Live</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Baseline</s-table-header>
        <s-table-header listSlot="secondary">Because of</s-table-header>
        <s-table-header listSlot="inline">State</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={`${row.variantGid}-${row.priceListGid}`}>
            <s-table-cell>{row.surface}</s-table-cell>
            <s-table-cell>
              {/* A whole column of blue is what makes a table read as link soup — and
                  this table is the one a merchant scans when prices disagree, so its
                  names should read as names. The icon carries "this opens the Shopify
                  admin", which the colour never did. */}
              <s-button variant="tertiary" icon="external" href={row.adminUrl} target="_blank">
                {row.title}
              </s-button>
            </s-table-cell>
            <s-table-cell>{row.live ?? "—"}</s-table-cell>
            <s-table-cell>{row.baseline ?? "—"}</s-table-cell>
            <s-table-cell>
              {row.campaignId ? (
                <s-button variant="tertiary" href={`/app/campaigns/${row.campaignId}`}>
                  {row.campaignName}
                </s-button>
              ) : (
                "—"
              )}
            </s-table-cell>
            <s-table-cell>
              <s-badge tone={row.drifted ? "critical" : row.offBaseline ? "info" : "success"}>
                {stateLabel(row)}
              </s-badge>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
