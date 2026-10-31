/**
 * The rollback report's shape and its CSV form.
 *
 * Deliberately not in the `.server` module that builds it. The export button runs in
 * the browser, and React Router strips `.server` imports from the client bundle — so
 * a serialiser that lived alongside the query would be `undefined` at the moment
 * somebody clicked Export, with nothing at build time to warn about it.
 */

import { countOf, formatCount } from "../format/display";
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
  /**
   * The price the ledger recorded before this campaign, set only where reverting puts back a
   * baseline that is not it (#781): one recaptured at the sale price, say. Null otherwise, and
   * where another campaign's price is what reverting leaves, which explains the difference.
   */
  before?: string | null;
}

export interface RollbackReport {
  campaignId: string;
  campaignName: string;
  rows: RollbackRow[];
  counts: { total: number; clean: number; drifted: number; deleted: number; unaffected: number };
  /** True when nothing needs a decision and the revert can just run. */
  straightforward: boolean;
  /**
   * The rows with a `before`, said above the table, which shows only some rows (#781): how
   * many, the first few, and how many of them have a baseline recaptured at this campaign's
   * own sale price. Absent when there are none, and on a report stored before it was counted.
   */
  notBefore?: {
    count: number;
    recaptured: number;
    examples: Array<{ title: string; before: string; revertsTo: string }>;
  };
  /**
   * The market and wholesale prices reverting puts back at this campaign's sale price, their
   * baseline recaptured at it while the campaign ran (#1166): how many, and the first few with
   * the market and the price before. The rows are base prices, so these are said on their own.
   */
  marketsNotBefore?: {
    count: number;
    examples: Array<{ title: string; market: string; before: string; revertsTo: string }>;
  };
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
 * What the Revert tab and dialog say about the variants reverting does not put back at their
 * price from before this campaign (#781), or null when there are none.
 *
 * The page said "We applied 80.00 · Live now 80.00 · Reverts to 80.00" of a $100 product whose
 * baseline had been recaptured at its sale price, and nothing about the $100 the ledger had.
 */
export function notBeforeSentence(notBefore: RollbackReport["notBefore"]): string | null {
  if (!notBefore || notBefore.count === 0) return null;
  const { count, recaptured, examples } = notBefore;
  const one = count === 1;
  const named = examples.map((row) => `“${row.title}” reverts to ${row.revertsTo}, not ${row.before}`).join("; ");
  const more = count > examples.length ? `; and ${formatCount(count - examples.length)} more, in the export` : "";
  const why =
    recaptured === 0
      ? ""
      : ` ${recaptured === count ? (one ? "Its baseline was" : "Their baselines were") : `${formatCount(recaptured)} of them had their baseline`} ` +
        "recaptured at this campaign's sale price, so reverting leaves the sale price in place. To end the sale at the price " +
        "from before it, import that price as the baseline on Prices → Baselines, then revert.";
  return (
    `${countOf(count, "variant")} ${one ? "reverts" : "revert"} to a different price from the one the ledger recorded ` +
    `before this campaign: ${named}${more}.${why}`
  );
}

/**
 * What the Revert tab and dialog say about the market and wholesale prices reverting leaves at
 * this campaign's sale price (#1166), or null when there are none.
 *
 * The base price's remedy is a baseline import, and an import sets the base price only. A market
 * price is the merchant's to set in Shopify once the sale has ended, and then to recapture.
 */
export function marketsNotBeforeSentence(markets: RollbackReport["marketsNotBefore"]): string | null {
  if (!markets || markets.count === 0) return null;
  const { count, examples } = markets;
  const one = count === 1;
  const named = examples.map((row) => `“${row.title}” in ${row.market} reverts to ${row.revertsTo}, not ${row.before}`).join("; ");
  const more = count > examples.length ? `; and ${formatCount(count - examples.length)} more` : "";
  return (
    `${countOf(count, "market price")} ${one ? "reverts" : "revert"} to this campaign's sale price, not the price before ` +
    `it: ${named}${more}. ${one ? "Its baseline was" : "Their baselines were"} recaptured at the sale price, and reverting ` +
    `writes a market's baseline back. An import cannot set a market's price, so to end the sale at the price from ` +
    `before it, revert, then set ${one ? "that price" : "those prices"} in Shopify and recapture ${one ? "its baseline" : "their baselines"} on ` +
    "Prices → Baselines."
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
    // `before_campaign` only where reverting does not put that price back (#781).
    ["variant_gid", "title", "state", "applied", "live_now", "reverts_to", "before_campaign"],
    report.rows.map((row) => [
      row.variantGid,
      row.title,
      row.kind,
      row.applied ?? "",
      row.live ?? "",
      row.revertsTo ?? "",
      row.before ?? "",
    ]),
  );
}
