/**
 * The reconciliation view as a file.
 *
 * On screen it is a page at a time; here it is the whole picture, which is what a
 * merchant sends to whoever asked "are the prices right?". So the columns have to stand
 * alone: a cell saying "drifted" means nothing without the two numbers that disagree.
 *
 * Blank is never used for a fact. A variant no campaign controls says so in words,
 * because an empty cell in a spreadsheet reads as missing data, and the merchant cannot
 * tell that apart from a bug in the export.
 */

import type { ReconciliationRow } from "../../services/reconciliation.server";
import { toCsv } from "./csv";

export function reconciliationCsv(rows: readonly ReconciliationRow[]): string {
  const header = [
    "Variant",
    "Title",
    "SKU",
    "Surface",
    "Currency",
    "Live price",
    "Baseline",
    "Controlled by",
    "We wrote",
    "State",
  ];

  const body = rows.map((row) => [
    row.variantGid,
    row.title,
    row.sku ?? "",
    row.surface,
    row.currency,
    row.live ?? "no price",
    row.baseline ?? "no baseline",
    row.campaignName ?? "no campaign",
    row.intended ?? "nothing written",
    describeState(row),
  ]);

  return toCsv(header, body);
}

/**
 * One cell that says what is going on, in the order that matters.
 *
 * Drift first: it is the only one of these a merchant has to act on. Being off baseline
 * is what a sale *is*, and reading it as a warning would make every running campaign
 * look broken.
 */
/**
 * The same four states, as a label rather than a sentence.
 *
 * `describeState` writes for a spreadsheet, where there is no colour and no neighbouring
 * column to lean on, so it spells the whole thing out. A badge is not a spreadsheet cell:
 * "drifted — live price is not what we wrote" rendered as a pill three times the width of
 * the column it sits in, restating the Live and Baseline columns either side of it.
 */
export function stateLabel(row: ReconciliationRow): string {
  if (row.drifted) return "Drifted";
  if (row.campaignName && row.offBaseline) return "On sale";
  if (row.offBaseline) return "Off baseline";
  return "At baseline";
}

export function describeState(row: ReconciliationRow): string {
  if (row.drifted) return "drifted — live price is not what we wrote";
  if (row.campaignName && row.offBaseline) return "on sale, as written";
  if (row.offBaseline) return "off baseline, no campaign controls it";
  return "at baseline";
}
