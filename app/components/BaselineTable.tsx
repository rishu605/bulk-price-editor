import { humanise } from "../lib/format/label";
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
        <s-table-header listSlot="primary">Variant</s-table-header>
        <s-table-header listSlot="secondary">SKU</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Baseline</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Live</s-table-header>
        <s-table-header listSlot="labeled">Source</s-table-header>
        {/* Was "Why", over two buttons labelled History and Shopify. Whatever it once
            meant, a merchant reading the header could only conclude the column held a
            reason -- and in the collapsed form that header is rendered as the label of
            the pair, so "Why: History Shopify" was the whole of it. */}
        <s-table-header listSlot="inline">Look up</s-table-header>
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
            <s-table-cell>{row.source ? humanise(row.source) : "—"}</s-table-cell>
            <s-table-cell>
              <s-stack direction="inline" gap="small">
                <s-button variant="tertiary" onClick={() => onShowHistory(row.variantGid)}>
                  History
                </s-button>
                {/* The same treatment as History beside it, which it was not: one cell
                    held a tertiary button and a blue link doing the same kind of job.
                    The icon is what says this one leaves the app. */}
                <s-button
                  variant="tertiary"
                  icon="external"
                  href={row.adminUrl}
                  target="_blank"
                >
                  Shopify
                </s-button>
              </s-stack>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
