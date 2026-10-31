/**
 * A baseline recaptured at a running campaign's own sale price (#781).
 *
 * Recapturing over a live sale is allowed once the merchant types the phrase. What happened
 * to the campaign that was running was invisible: it went on reading "every row was read back
 * and verified", its preview proposed its discount again on top of its own sale price (a 20%
 * sale took a $100 product to $64 on DartMode Labs), and its revert put back the sale price,
 * because that is now the baseline. The ledger still had $100.
 *
 * So these decide it from the ledger, per variant: what the campaign has written there since
 * it last reverted there, and what the ledger recorded before the first of those writes. Pure,
 * so the page's status, the Apply confirmation and the revert report all read one rule.
 */

/** One ledger row of a campaign's for one variant's base price, as these read it. */
export interface StintRow {
  /** Written by the campaign's revert, which ends a stint, rather than by one of its applies. */
  revert: boolean;
  /** The live price the ledger recorded before this write, in minor units. */
  before: bigint | null;
  /** The price this write put on the storefront, in minor units. */
  intended: bigint | null;
  /** When the row was written, before the price was. */
  at: Date;
}

/**
 * The campaign's writes on a variant since it last reverted there, newest first, from that
 * variant's rows newest first. Empty when its newest row is its revert's: the campaign is not
 * pricing the variant now.
 */
export function stintOf<T extends Pick<StintRow, "revert">>(rows: readonly T[]): T[] {
  const stint: T[] = [];
  for (const row of rows) {
    if (row.revert) break;
    stint.push(row);
  }
  return stint;
}

/**
 * The price the ledger recorded before the campaign: the first write of its stint's "before".
 * Not the newest write's, which after a second apply is the campaign's own earlier price.
 */
export function priceBeforeStint(stint: readonly Pick<StintRow, "before">[]): bigint | null {
  return stint.length === 0 ? null : stint[stint.length - 1]!.before;
}

/**
 * Whether the variant's current baseline is this campaign's sale price, recaptured while the
 * campaign was live: captured after the stint's first write, at a price one of its writes put
 * on the storefront, and not the price the ledger recorded before it.
 *
 * Read from the baseline and the ledger, not from the recapture's audit entry, so a baseline
 * that became the sale price by Flow's Capture baselines or an import is found the same way.
 * A baseline captured after the first write at some other price -- a supplier increase
 * imported mid-sale -- is the merchant's new normal price, and is not this.
 */
export function recapturedAtSale(
  stint: readonly StintRow[],
  baseline: { price: bigint; capturedAt: Date },
): boolean {
  if (stint.length === 0) return false;
  const first = stint[stint.length - 1]!;
  if (first.before === null || first.before === baseline.price) return false;
  if (baseline.capturedAt.getTime() <= first.at.getTime()) return false;
  return stint.some((row) => row.intended === baseline.price);
}
