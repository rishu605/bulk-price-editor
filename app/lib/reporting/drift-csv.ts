/**
 * The drift queue as a file: every drifted price the page's filters match, not the fifteen
 * on screen (#822, #819).
 *
 * One row per drifted price, with both numbers as plain amounts and the currency beside
 * them -- "$1,299.00" in a cell is text to a spreadsheet, and a merchant sorting a thousand
 * edits by how far they moved needs numbers.
 */

import type { DriftRow } from "../../services/drift.server";
import { toCsv } from "./csv";

export function driftCsv(rows: readonly DriftRow[]): string {
  const header = [
    "Variant ID",
    "Title",
    "Variant SKU",
    "Campaign",
    "Campaign set",
    "Now shows",
    "Currency",
    "Direction",
    "Still on the storefront",
    "Detected at",
  ];

  const body = rows.map((row) => [
    row.variantGid,
    row.title,
    row.sku ?? "",
    row.campaignName ?? "",
    row.expected ?? "",
    row.observed ?? "",
    row.currency,
    row.direction === "up" ? "Raised" : row.direction === "down" ? "Lowered" : "",
    row.stillShown ? "Yes" : "No",
    row.detectedAt,
  ]);

  return toCsv(header, body);
}
