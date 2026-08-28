import { humanise } from "../lib/format/label";
import { formatWhen } from "../lib/format/display";
import type { RunSummary } from "../services/campaigns/index.server";
import { RUN_TONE, toneFor } from "./tone";

interface Props {
  /** The shop's timezone. A run time in the server's zone is a run time in the wrong zone. */
  timeZone: string;
  runs: RunSummary[];
  /** The run whose ledger is currently shown. */
  selectedRunId: string | null;
}

/** Every apply and revert for a campaign, newest first. */
export function RunHistoryTable({ runs, selectedRunId, timeZone }: Props) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Run</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Planned</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Verified</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Failed</s-table-header>
        <s-table-header listSlot="kicker">Finished</s-table-header>
        <s-table-header listSlot="inline"></s-table-header>
      </s-table-header-row>
      <s-table-body>
        {runs.map((run) => (
          <s-table-row key={run.id}>
            <s-table-cell>{humanise(run.kind)}</s-table-cell>
            <s-table-cell>
              <s-badge tone={toneFor(RUN_TONE, run.status)}>{humanise(run.status)}</s-badge>
            </s-table-cell>
            <s-table-cell>{run.planned}</s-table-cell>
            <s-table-cell>{run.verified}</s-table-cell>
            <s-table-cell>{run.failed}</s-table-cell>
            <s-table-cell>
              {run.finishedAt ? formatWhen(run.finishedAt, timeZone) : "—"}
            </s-table-cell>
            <s-table-cell>
              {run.id === selectedRunId ? (
                <s-text>Showing</s-text>
              ) : (
                <s-button variant="tertiary" href={`?run=${run.id}`}>
                  View ledger
                </s-button>
              )}
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
