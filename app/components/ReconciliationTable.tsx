import { NoMatches } from "./AsyncState";
import { Blank } from "./Blank";
import type { ReconciliationRow } from "../services/reconciliation.server";
import { stateLabel } from "../lib/reporting/reconciliation-csv";
import { RowState } from "./RowState";

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
export function ReconciliationTable({
  rows,
  clearHref,
}: {
  rows: ReconciliationRow[];
  /** Where Clear filters goes. The route owns the field list, so it builds the link. */
  clearHref: string;
}) {
  if (rows.length === 0) {
    // The old copy guessed: "if you were looking for drifted prices, that is good news."
    // On a page with four filters, an empty result far more often means the filters
    // exclude each other -- a campaign on one surface, a state that surface is never in
    // -- and being congratulated for it is how a merchant concludes the page is broken.
    return (
      <NoMatches
        noun="prices"
        description="This page lists every variant on every surface it sells on, so a filter that narrows two of those at once can exclude everything."
        clearHref={clearHref}
      />
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
            <s-table-cell>{row.live ?? <Blank />}</s-table-cell>
            <s-table-cell>{row.baseline ?? <Blank />}</s-table-cell>
            <s-table-cell>
              {row.campaignId ? (
                <s-button variant="tertiary" href={`/app/campaigns/${row.campaignId}`}>
                  {row.campaignName}
                </s-button>
              ) : (
                <Blank />
              )}
            </s-table-cell>
            <s-table-cell>
              {/* A store that reconciles is every row matching, and this table exists to
                  be scanned for the ones that do not. */}
              <RowState
                label={stateLabel(row)}
                tone={row.drifted ? "critical" : row.offBaseline ? "info" : "success"}
                ordinary={!row.drifted && !row.offBaseline}
              />
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
