/**
 * The rollback report's shape and its CSV form.
 *
 * Deliberately not in the `.server` module that builds it. The export button runs in
 * the browser, and React Router strips `.server` imports from the client bundle — so
 * a serialiser that lived alongside the query would be `undefined` at the moment
 * somebody clicked Export, with nothing at build time to warn about it.
 */

import { toCsv } from "./csv";

export type RollbackRowKind =
  /** Live value matches what we applied. Reverting is uncontroversial. */
  | "clean"
  /** Live value differs from what we applied — somebody edited it. */
  | "drifted"
  /** Variant no longer exists in Shopify. Nothing to revert. */
  | "deleted";

export interface RollbackRow {
  variantGid: string;
  title: string;
  kind: RollbackRowKind;
  /** What this campaign last wrote, from the ledger. */
  applied: string | null;
  /** What the storefront shows now, from the mirror. */
  live: string | null;
  /** What `resolve(without this campaign)` would write. */
  revertsTo: string | null;
}

export interface RollbackReport {
  campaignId: string;
  campaignName: string;
  rows: RollbackRow[];
  counts: { total: number; clean: number; drifted: number; deleted: number };
  /** True when nothing needs a decision and the revert can just run. */
  straightforward: boolean;
}

/**
 * Which of the three states a row is in.
 *
 * Pure, so the boundaries are testable without a database — and they need to be,
 * because the default matters. An unknown comparison resolves to `clean`, meaning the
 * revert proceeds. That is the right way round: `drifted` asks a person a question,
 * and a report that invents questions about rows nobody touched is a report people
 * learn to click through, which is how the real ones get missed.
 */
export function classifyRollbackRow(input: {
  deleted: boolean;
  /** What the campaign wrote, in minor units. */
  applied: number | null;
  /** What the mirror says is live, in minor units. */
  live: number | null;
}): RollbackRowKind {
  if (input.deleted) return "deleted";
  if (input.applied === null || input.live === null) return "clean";
  return input.live === input.applied ? "clean" : "drifted";
}

/**
 * The report as CSV.
 *
 * Exportable because this is the artefact somebody forwards to whoever made the
 * edits, or keeps as the record of a decision about a few thousand prices. A report
 * you can only look at is not a record of anything.
 */
export function rollbackReportCsv(report: RollbackReport): string {
  return toCsv(
    ["variant_gid", "title", "state", "applied", "live_now", "reverts_to"],
    report.rows.map((row) => [
      row.variantGid,
      row.title,
      row.kind,
      row.applied ?? "",
      row.live ?? "",
      row.revertsTo ?? "",
    ]),
  );
}
