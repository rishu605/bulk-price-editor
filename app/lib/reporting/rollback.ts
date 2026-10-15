/**
 * The rollback report's shape and its CSV form.
 *
 * Deliberately not in the `.server` module that builds it. The export button runs in
 * the browser, and React Router strips `.server` imports from the client bundle — so
 * a serialiser that lived alongside the query would be `undefined` at the moment
 * somebody clicked Export, with nothing at build time to warn about it.
 */

import { formatCount } from "../format/display";
import { toCsv } from "./csv";

export type RollbackRowKind =
  /** Live value matches what we applied. Reverting is uncontroversial. */
  | "clean"
  /** Live value is neither what we applied nor what reverting writes — somebody edited it. */
  | "drifted"
  /** Variant no longer exists in Shopify. Nothing to revert. */
  | "deleted"
  /**
   * Live value is already what reverting writes: a higher-priority campaign's price, or the
   * baseline. Nothing is written for it and there is nothing to decide (#836).
   */
  | "unaffected";

export interface RollbackRow {
  variantGid: string;
  title: string;
  kind: RollbackRowKind;
  /**
   * What this campaign last wrote, from the ledger -- or, for a variant another campaign's
   * revert handed it, this campaign's price as that revert wrote it (#837).
   */
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
  counts: { total: number; clean: number; drifted: number; deleted: number; unaffected: number };
  /** True when nothing needs a decision and the revert can just run. */
  straightforward: boolean;
}

/**
 * Which of the four states a row is in.
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
  /**
   * What reverting writes, in minor units: `resolve(without C)` from the revert's own
   * planner. Null when that planner gives no price -- it leaves the variant alone.
   */
  revertsTo: number | null;
}): RollbackRowKind {
  if (input.deleted) return "deleted";
  if (input.applied === null || input.live === null) return "clean";
  if (input.live === input.applied) return "clean";
  // A live price that is already the revert's answer is not a decision anybody has to make.
  // Usually a higher-priority campaign took the variant over -- routine, which is what
  // priority is for -- and the report called it "changed since … someone edited those on
  // purpose" and took the plain Revert away for the ordinary case (#836). Asking would be
  // asking whether to write a price that is already there.
  if (input.live === input.revertsTo) return "unaffected";
  return "drifted";
}

/**
 * The Revert tab's opening sentence.
 *
 * "All N variants are still at the price this campaign set" was said of every row once
 * nothing was drifted -- including a variant a higher-priority campaign had taken over,
 * whose live price is that campaign's (#836). Only the clean rows are at this campaign's
 * price, so only they are counted as such.
 *
 * What reverting does is the tab's next paragraph, so it is not said here as well: the
 * two sentences in a row read the same thing twice (#759). The counts are grouped and
 * agree with one, because "1 of 3 variants have been changed" was this sentence too.
 */
export function rollbackSummary(counts: RollbackReport["counts"]): string {
  const { total, clean, drifted } = counts;
  const of = (part: number) => `${formatCount(part)} of ${formatCount(total)} variants`;
  if (drifted > 0) {
    return (
      `${of(drifted)} ${drifted === 1 ? "has" : "have"} been changed since this campaign set ${drifted === 1 ? "it" : "them"}. ` +
      `Someone edited ${drifted === 1 ? "it" : "those"} on purpose — tick any you want left alone, then revert.`
    );
  }
  if (clean === total) {
    return total === 1
      ? "The 1 variant is still at the price this campaign set."
      : `All ${formatCount(total)} variants are still at the price this campaign set.`;
  }
  if (clean === 0) return "None of these variants shows this campaign's price now.";
  return `${of(clean)} ${clean === 1 ? "is" : "are"} still at the price this campaign set.`;
}

/**
 * The rows reverting leaves where they are, said where the report's counts are (#836): their
 * live price is already the revert's answer. Null when there are none.
 */
export function unaffectedSentence(unaffected: number): string | null {
  if (unaffected === 0) return null;
  const one = unaffected === 1;
  return (
    `${formatCount(unaffected)} ${one ? "variant already shows" : "variants already show"} the price reverting gives ` +
    `${one ? "it" : "them"} — another campaign's, or the normal price — so there is nothing to decide about ${one ? "it" : "them"}.`
  );
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
