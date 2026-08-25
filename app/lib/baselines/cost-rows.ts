/**
 * Reading unit costs from a spreadsheet.
 *
 * Cost is what the margin guardrails compute against, and most catalogues arrive with it
 * missing — Shopify does not require it, and a store built by importing a supplier feed
 * usually has it in the supplier's spreadsheet rather than in Shopify. Until it is here,
 * "never price below cost" is a setting a merchant can switch on and get nothing from,
 * because every variant without a cost is skipped.
 *
 * Deliberately not a price. Importing a cost changes no storefront value and needs no
 * write to Shopify; it changes what the app will *refuse* to do. That makes it the one
 * import that can be applied directly rather than through a campaign — and it also means
 * a wrong cost is not a wrong price, only a wrong floor, which is why this validates
 * less severely than the baseline importer.
 */

import { parseMoney, type Money } from "../money/money";
import type { RawRow } from "./csv-rows";

export interface ValidCostRow extends RawRow {
  parsedCost: Money;
}

export type CostProblem = "no-identifier" | "no-cost" | "cost-unparseable" | "cost-negative";

export interface InvalidCostRow extends RawRow {
  problem: CostProblem;
  reason: string;
}

const REASONS: Record<CostProblem, string> = {
  "no-identifier": "No SKU, barcode or variant ID in this row — nothing to match on.",
  "no-cost": "No cost given. Leave the row out rather than leaving the cost blank.",
  "cost-unparseable":
    "Cost is not a plain number. Remove currency symbols and thousands separators — 12.50, not $12.50.",
  "cost-negative": "Cost cannot be negative.",
};

export function validateCostRow(
  row: RawRow,
  shopCurrency: string,
): ValidCostRow | InvalidCostRow {
  const fail = (problem: CostProblem): InvalidCostRow => ({
    ...row,
    problem,
    reason: REASONS[problem],
  });

  if (!row.identifier.trim()) return fail("no-identifier");

  const raw = (row.cost ?? "").trim();
  if (!raw) return fail("no-cost");

  const currency = (row.currency || shopCurrency).toUpperCase();

  let parsedCost: Money;
  try {
    parsedCost = parseMoney(raw, currency);
  } catch {
    return fail("cost-unparseable");
  }

  // Zero is allowed, unlike a zero baseline. A genuinely free item — a sample, a
  // giveaway — has a cost of nothing, and refusing it would force the merchant to leave
  // the row out and lose the fact that its cost is known to be zero.
  if (parsedCost.amount < 0) return fail("cost-negative");

  return { ...row, parsedCost };
}

export function isValidCost(row: ValidCostRow | InvalidCostRow): row is ValidCostRow {
  return "parsedCost" in row;
}
