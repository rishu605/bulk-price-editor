import { useState } from "react";

import { formatCount } from "../lib/format/display";
import { downloadExport } from "../lib/reporting/csv";

/**
 * Exports every row of what a page describes, from the server (#819), and says how many.
 *
 * It used to build the file in the browser from the rows on screen, and a "ledger" export
 * of a 3,666-row run held about 60. The label now names the count the file will hold, and a
 * refusal (too many rows, a run still writing) is shown beside the button.
 */
export function ExportButton({
  href,
  filename,
  rows,
  noun = ["row", "rows"],
}: {
  /** The export route, carrying the page's own filters. */
  href: string;
  filename: string;
  /** How many rows the file holds. */
  rows: number;
  /**
   * What a row is, singular and plural. Both, not a plural with its "s" trimmed: that made
   * one activity entry "Export the 1 entrie" (#947).
   */
  noun?: readonly [singular: string, plural: string];
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <>
      <s-button
        type="button"
        variant="tertiary"
        icon="download"
        loading={busy || undefined}
        disabled={rows === 0 || undefined}
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          try {
            setProblem(await downloadExport(href, filename));
          } catch {
            setProblem("The export didn't download. Check your connection and try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {exportLabel(rows, noun)}
      </s-button>
      {problem ? <s-text tone="critical">{problem}</s-text> : null}
    </>
  );
}

/** "Export the 1 entry (CSV)", or "Export all 1,204 entries (CSV)". */
export function exportLabel(rows: number, [singular, plural]: readonly [string, string]): string {
  return rows === 1 ? `Export the 1 ${singular} (CSV)` : `Export all ${formatCount(rows)} ${plural} (CSV)`;
}
