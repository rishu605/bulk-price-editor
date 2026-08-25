/**
 * The review step as a file, surface columns intact.
 *
 * The on-screen table is deliberately short — the widget stops rendering past a few
 * hundred cells — so the export is where a merchant checks a campaign that touches
 * thousands of variants across several markets. It is the same data, not a summary of
 * it, and it must stay comparable column by column.
 *
 * A market a variant is not sold in gets "not sold here" rather than an empty cell.
 * Empty reads as "no change" in a spreadsheet, and the two are entirely different
 * facts about a merchant's catalogue.
 */

import type { MarketPreview, PreviewRow } from "../../services/campaigns/types";
import { toCsv } from "./csv";

export function previewCsv(
  rows: readonly PreviewRow[],
  markets: readonly MarketPreview[],
): string {
  const header = [
    "Variant",
    "Title",
    "Before",
    "After",
    "Compare at",
    "State",
    "Reason",
    // Two columns per market: a merchant checking a sale needs both the price and the
    // strike-through, and a single combined column cannot be sorted or summed.
    ...markets.flatMap((market) => [
      `${market.name} (${market.currency})`,
      `${market.name} compare at`,
    ]),
  ];

  const body = rows.map((row) => [
    row.variantGid,
    row.title,
    row.before ?? "",
    row.after ?? "",
    row.compareAt ?? "",
    row.status,
    row.reason ?? "",
    ...markets.flatMap((market) => {
      const cell = row.surfaces?.[market.priceListGid];
      if (!cell) return ["not sold here", "not sold here"];
      if (cell.status !== "pending") {
        const state = cell.reason ? `${cell.status}: ${cell.reason}` : cell.status;
        return [state, ""];
      }
      return [cell.after ?? "", cell.compareAt ?? ""];
    }),
  ]);

  return toCsv(header, body);
}
