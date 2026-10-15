/**
 * What a pasted list of SKUs, barcodes or ids matched, in sentences.
 *
 * Two different counts, and they were run together (#759). A row is a line of the list; a
 * row naming a product id matches every one of its variants. "2049 of 2 rows" put the
 * variant count over the row count with "of" between them. Rows are counted against rows,
 * and the variants the list pins are said beside them.
 */

import { countOf, formatCount } from "../format/display";

export interface ListReport {
  /** Rows in the list. */
  total: number;
  /** Variants the list pins, deduplicated. */
  matched: number;
  unmatched: readonly unknown[];
  ambiguous: readonly unknown[];
  /** Rows that repeat an earlier one, counted once. */
  repeated: number;
}

/** Rows that placed something: not unmatched, not ambiguous, and not a repeat. */
export function placedRows(report: ListReport): number {
  return report.total - report.unmatched.length - report.ambiguous.length - report.repeated;
}

/** "2 of 2 rows matched a product, 2,049 variants in all." */
export function listMatchedSentence(report: ListReport): string {
  return `${formatCount(placedRows(report))} of ${countOf(report.total, "row")} matched a product, ${countOf(report.matched, "variant")} in all.`;
}

/** 'Created "Summer list" with 2,049 variants, from 2 of 2 rows.' */
export function listCreatedMessage(name: string, report: ListReport): string {
  return `Created "${name}" with ${countOf(report.matched, "variant")}, from ${formatCount(placedRows(report))} of ${countOf(report.total, "row")}.`;
}
