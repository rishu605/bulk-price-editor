/**
 * A run's ledger as a file.
 *
 * This is the record of what the app did to a merchant's storefront: every variant it
 * intended to change, what it wrote, and whether Shopify confirmed. It is what gets
 * attached to a support ticket, and what a merchant's finance team asks for when a price
 * on an invoice does not match what they expected.
 *
 * So a failed row keeps its reason in the file. An export that dropped the failures
 * would show a clean run that was not clean, which is the specific dishonesty this whole
 * product is built against.
 */

import type { LedgerRow } from "../../services/campaigns/types";
import { toCsv } from "./csv";

export function ledgerCsv(rows: readonly LedgerRow[]): string {
  const header = ["Variant", "Title", "Before", "We wrote", "Status", "Why not"];

  const body = rows.map((row) => [
    row.variantGid,
    row.title,
    row.before ?? "",
    row.intended ?? "",
    row.status,
    row.failureReason ?? "",
  ]);

  return toCsv(header, body);
}
