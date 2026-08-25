import type { BaselineRow } from "../services/baseline-browser.server";

/**
 * A variant, its baseline, and what the storefront shows.
 *
 * Its own component like every other table here — see ActivityTable for what happens
 * when a large `s-table` renders inline, and keep the page size small.
 */
export function BaselineTable({
  rows,
  onShowHistory,
}: {
  rows: BaselineRow[];
  onShowHistory: (variantGid: string) => void;
}) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Variant</s-table-header>
        <s-table-header>SKU</s-table-header>
        <s-table-header>Baseline</s-table-header>
        <s-table-header>Live</s-table-header>
        <s-table-header>Source</s-table-header>
        <s-table-header>Why</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>{row.sku ?? "—"}</s-table-cell>
            <s-table-cell>{row.baseline ?? "—"}</s-table-cell>
            <s-table-cell>
              {row.live ?? "—"}
              {row.diverged ? (
                // Expected during a campaign, a warning outside one — so the badge
                // says "differs" rather than "wrong".
                <>
                  {" "}
                  <s-badge tone="warning">differs</s-badge>
                </>
              ) : null}
            </s-table-cell>
            <s-table-cell>{row.source?.toLowerCase().replace(/_/g, " ") ?? "—"}</s-table-cell>
            <s-table-cell>
              <s-stack direction="inline" gap="small">
                <s-button variant="tertiary" onClick={() => onShowHistory(row.variantGid)}>
                  History
                </s-button>
                <s-link href={row.adminUrl} target="_blank">
                  Shopify
                </s-link>
              </s-stack>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
