import type { RollbackRow } from "../services/campaigns/index.server";

/**
 * What reverting would do, row by row, with the drifted ones first.
 *
 * The checkbox is the whole point. A row somebody edited by hand while the sale ran
 * is a decision, and reverting it silently overwrites that decision — so the merchant
 * gets to keep it, per row, rather than choosing between "revert everything" and
 * "revert nothing".
 *
 * Clean rows are shown too, greyed of choice. Seeing that 3,412 rows will revert
 * without argument is what makes the eleven that need attention legible as eleven
 * rather than as an unbounded worry.
 */

const STATE: Record<RollbackRow["kind"], { label: string; tone: "info" | "warning" | "neutral" }> = {
  drifted: { label: "Changed since", tone: "warning" },
  deleted: { label: "Deleted", tone: "neutral" },
  clean: { label: "Unchanged", tone: "info" },
};

export function RollbackReportTable({ rows }: { rows: RollbackRow[] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Variant</s-table-header>
        <s-table-header>State</s-table-header>
        <s-table-header>We applied</s-table-header>
        <s-table-header>Live now</s-table-header>
        <s-table-header>Reverts to</s-table-header>
        <s-table-header>Keep the edit</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>
              <s-badge tone={STATE[row.kind].tone}>{STATE[row.kind].label}</s-badge>
            </s-table-cell>
            <s-table-cell>{row.applied ?? "—"}</s-table-cell>
            <s-table-cell>{row.live ?? "—"}</s-table-cell>
            <s-table-cell>{row.revertsTo ?? "—"}</s-table-cell>
            <s-table-cell>
              {row.kind === "drifted" ? (
                // Named `keep`, and read as a list by the revert action. Unchecked by
                // default: reverting is what the merchant asked for, and the checkbox
                // is them making an exception, not confirming the obvious.
                <s-checkbox name="keep" value={row.variantGid} label="Leave as it is" />
              ) : (
                <s-text>—</s-text>
              )}
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
