import { humanise } from "../lib/format/label";
import type { ReactNode } from "react";

import type { LedgerRow } from "../services/campaigns/index.server";
import { LEDGER_TONE, toneFor } from "./tone";

/**
 * Every row we wrote, with what it was and what we intended.
 *
 * Retained indefinitely on every plan -- charging to explain what you did to
 * someone's prices is the wrong trade.
 */
export function LedgerTable({
  rows,
  /**
   * Optional per-row control, rendered in a trailing column.
   *
   * A render prop rather than a flag, because the action needs a fetcher and this
   * component has no business knowing about one. Passing the markup in keeps the
   * table a table.
   */
  renderAction,
}: {
  rows: LedgerRow[];
  renderAction?: (row: LedgerRow) => ReactNode;
}) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Variant</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Before</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Intended</s-table-header>
        <s-table-header listSlot="inline">State</s-table-header>
        <s-table-header listSlot="labeled">Reason</s-table-header>
        {renderAction ? <s-table-header listSlot="inline">Action</s-table-header> : null}
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>{row.before ?? "—"}</s-table-cell>
            <s-table-cell>{row.intended ?? "—"}</s-table-cell>
            <s-table-cell>
              <s-badge tone={toneFor(LEDGER_TONE, row.status)}>{humanise(row.status)}</s-badge>
            </s-table-cell>
            <s-table-cell>{row.failureReason ?? "—"}</s-table-cell>
            {renderAction ? <s-table-cell>{renderAction(row)}</s-table-cell> : null}
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
