import type { LedgerRow } from "../services/campaigns/index.server";
import { LEDGER_TONE, toneFor } from "./tone";

/**
 * Every row we wrote, with what it was and what we intended.
 *
 * Retained indefinitely on every plan -- charging to explain what you did to
 * someone's prices is the wrong trade.
 */
export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Variant</s-table-header>
        <s-table-header>Before</s-table-header>
        <s-table-header>Intended</s-table-header>
        <s-table-header>State</s-table-header>
        <s-table-header>Reason</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>{row.before ?? "—"}</s-table-cell>
            <s-table-cell>{row.intended ?? "—"}</s-table-cell>
            <s-table-cell>
              <s-badge tone={toneFor(LEDGER_TONE, row.status)}>{row.status}</s-badge>
            </s-table-cell>
            <s-table-cell>{row.failureReason ?? "—"}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
