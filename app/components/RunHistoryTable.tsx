import { useSearchParams } from "react-router";

import { humanise } from "../lib/format/label";
import { Blank } from "./Blank";
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

/**
 * Where "View ledger" goes: the Ledger tab, showing that run, the page's other parameters
 * kept (#724).
 *
 * It was `?run=<id>`, and a relative query replaces the whole query: `tab=runs` went with
 * it, the page fell back to its first tab, and the merchant who asked for a ledger landed on
 * Overview with nothing saying where the ledger had gone.
 */
/** Which run's ledger a link opens, for a screen reader moving through the column (#796). */
export function runLedgerName(run: { kind: string; finishedAt: string | null }, timeZone: string): string {
  const which = `${humanise(run.kind).toLowerCase()} run`;
  return run.finishedAt ? `View the ledger of the ${which} that finished ${formatWhen(run.finishedAt, timeZone)}` : `View the ledger of the ${which} still running`;
}

export function ledgerHref(current: URLSearchParams, runId: string): string {
  const next = new URLSearchParams(current);
  next.set("tab", "ledger");
  next.set("run", runId);
  return `?${next}`;
}

/** Whether a run left ledger rows: planned or skipped, every row it considered is one. */
const hasLedger = (run: RunSummary) => run.planned + run.skipped > 0;

/** Every apply and revert for a campaign, newest first. */
export function RunHistoryTable({ runs, selectedRunId, timeZone }: Props) {
  const [params] = useSearchParams();
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Run</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Planned</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Verified</s-table-header>
        <s-table-header listSlot="labeled" format="numeric">Failed</s-table-header>
        <s-table-header listSlot="kicker">Finished</s-table-header>
        <s-table-header listSlot="inline">Ledger</s-table-header>
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
              {run.finishedAt ? formatWhen(run.finishedAt, timeZone) : <Blank />}
            </s-table-cell>
            <s-table-cell>
              {run.id === selectedRunId ? (
                <s-text>Showing</s-text>
              ) : hasLedger(run) ? (
                <s-link href={ledgerHref(params, run.id)} accessibilityLabel={runLedgerName(run, timeZone)}>
                  View ledger
                </s-link>
              ) : (
                // No rows, so no Ledger tab to open: the page would fall back to Overview.
                <s-text color="subdued">Nothing written</s-text>
              )}
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
