/**
 * The baseline browser as a file, in a shape it can be re-imported from.
 *
 * The round trip is the point: export, edit in Excel, import. So the headers are the
 * ones the importer recognises rather than the ones that read best on screen, and the
 * prices are plain numbers — a merchant who exported "$1,299.00" and imported it again
 * would get a row-level error on every line, which makes the export useless for the one
 * job it has.
 */

import type { BaselineRow } from "../../services/baseline-browser.server";
import { toCsv } from "./csv";

export function baselinesCsv(rows: readonly BaselineRow[]): string {
  // "Variant SKU" and "Variant Price" rather than "SKU" and "Baseline": Matrixify's
  // names, so the same file opens in the workflow a merchant already has.
  const header = [
    "Variant SKU",
    "Variant ID",
    "Title",
    "Vendor",
    "Variant Price",
    "Live price",
    "Source",
    "Captured at",
  ];

  const body = rows.map((row) => [
    row.sku ?? "",
    row.variantGid,
    row.title,
    row.vendor ?? "",
    plain(row.baseline),
    plain(row.live),
    row.source ?? "",
    row.capturedAt ?? "",
  ]);

  return toCsv(header, body);
}

/**
 * A formatted price back to a plain number.
 *
 * The screen wants "$1,299.00"; the importer wants "1299.00" and rejects anything else.
 * Exporting the display form would make every round trip fail on every row.
 */
export function plain(formatted: string | null): string {
  if (!formatted) return "";
  return formatted.replace(/[^\d.-]/g, "");
}
