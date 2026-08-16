import type { PreviewRow } from "../services/campaigns/index.server";
import { PREVIEW_TONE, toneFor } from "./tone";

/** Before/after for each variant a campaign would change. */
export function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) {
    return (
      <s-paragraph>
        Nothing to change. Either every variant already shows the target price, or the
        scope matched no variants with baselines.
      </s-paragraph>
    );
  }

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Variant</s-table-header>
        <s-table-header>Before</s-table-header>
        <s-table-header>After</s-table-header>
        <s-table-header>Compare at</s-table-header>
        <s-table-header>State</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.variantGid}>
            <s-table-cell>{row.title}</s-table-cell>
            <s-table-cell>{row.before ?? "—"}</s-table-cell>
            <s-table-cell>{row.after ?? "—"}</s-table-cell>
            <s-table-cell>{row.compareAt ?? "—"}</s-table-cell>
            <s-table-cell>
              <s-badge tone={toneFor(PREVIEW_TONE, row.status)}>
                {row.status}
                {row.reason ? ` · ${row.reason}` : ""}
              </s-badge>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
