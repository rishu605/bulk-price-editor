/**
 * Comparing what we asked Shopify to store against what it says it stored.
 *
 * This is what invariant I5 actually means. "Shopify accepted the mutation" is not the
 * same claim as "the price on the storefront is the price we intended", and the gap
 * between them is where a silently wrong price lives: a rounding rule, a currency with
 * different precision, a price list that adjusts what it was handed.
 *
 * Extracted because both write paths need it and they were not agreeing. The sync path
 * read prices back and compared them; the bulk path — the one every large campaign takes —
 * checked only that no `userError` came back, and threw away the price Shopify returned
 * in the very same response. A verification that the biggest runs skip is not a
 * verification.
 */

import { formatMoney, money, type Money } from "../money/money";

export type ReadBackVerdict =
  | { ok: true; observed: Money }
  | { ok: false; reason: string; observed?: Money };

/**
 * Shopify reports money as a decimal string; the ledger holds integer minor units.
 *
 * The scale comes from formatting the intended amount rather than from a currency table,
 * so zero-decimal currencies (JPY) and three-decimal ones (KWD) both round-trip. Getting
 * this wrong by a factor of a hundred is exactly the class of bug that makes a comparison
 * fail on every row, or pass on none.
 */
export function parseObserved(text: string, intended: Money): Money | null {
  const value = Number(text);
  if (!Number.isFinite(value)) return null;

  return money(Math.round(value * 10 ** decimalsOf(intended)), intended.currency);
}

/**
 * Whether a row may be called verified.
 *
 * An absent price is a refusal, not a pass. A read that came back without the field tells
 * us nothing, and treating "no answer" as "correct" is how a partial run reports clean.
 */
export function readBackVerdict(
  intended: Money | undefined,
  observedText: string | null | undefined,
): ReadBackVerdict {
  if (!intended) {
    return { ok: false, reason: "No intended price to verify against." };
  }
  if (observedText === null || observedText === undefined || observedText === "") {
    return { ok: false, reason: "Verification read returned no price for this variant." };
  }

  const observed = parseObserved(observedText, intended);
  if (!observed) {
    return { ok: false, reason: `Verification read returned "${observedText}", which is not a price.` };
  }

  if (observed.amount !== intended.amount) {
    return {
      ok: false,
      // Names the object, the cause and both numbers: support reads these, and "mismatch"
      // on its own sends them back to the Shopify admin to find out what happened.
      reason: `Read-back mismatch: expected ${formatMoney(intended)}, found ${observedText}.`,
      observed,
    };
  }

  return { ok: true, observed };
}

function decimalsOf(amount: Money): number {
  // Derived from the formatted representation so zero-decimal currencies (JPY) and
  // three-decimal ones (KWD) both round-trip correctly.
  const formatted = formatMoney(amount);
  const dot = formatted.indexOf(".");
  return dot === -1 ? 0 : formatted.length - dot - 1;
}
