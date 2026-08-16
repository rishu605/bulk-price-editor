import type { RunSummary } from "../services/campaigns/index.server";
import { RUN_TONE, toneFor } from "./tone";

interface Props {
  runs: RunSummary[];
  /** The run whose ledger is currently shown. */
  selectedRunId: string | null;
}

/** Every apply and revert for a campaign, newest first. */
export function RunHistoryTable({ runs, selectedRunId }: Props) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Run</s-table-header>
        <s-table-header>Status</s-table-header>
        <s-table-header>Planned</s-table-header>
        <s-table-header>Verified</s-table-header>
        <s-table-header>Failed</s-table-header>
        <s-table-header>Finished</s-table-header>
        <s-table-header></s-table-header>
      </s-table-header-row>
      <s-table-body>
        {runs.map((run) => (
          <s-table-row key={run.id}>
            <s-table-cell>{run.kind}</s-table-cell>
            <s-table-cell>
              <s-badge tone={toneFor(RUN_TONE, run.status)}>{run.status}</s-badge>
            </s-table-cell>
            <s-table-cell>{run.planned}</s-table-cell>
            <s-table-cell>{run.verified}</s-table-cell>
            <s-table-cell>{run.failed}</s-table-cell>
            <s-table-cell>
              {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}
            </s-table-cell>
            <s-table-cell>
              {run.id === selectedRunId ? (
                <s-text>Showing</s-text>
              ) : (
                <s-link href={`?run=${run.id}`}>View ledger</s-link>
              )}
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
