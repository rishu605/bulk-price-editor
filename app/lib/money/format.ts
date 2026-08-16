/**
 * Display formatting for values stored as minor units in the database.
 *
 * Services read `bigint` columns, not `Money`, so they need a formatter that takes
 * the raw value. Three separate copies of this had grown across the service layer,
 * each hardcoding `["JPY", "KRW"]` as the zero-decimal list -- which is wrong: the
 * real table has seventeen zero-decimal currencies and seven three-decimal ones, so
 * those copies would render BHD and KWD with two decimals instead of three and put a
 * spurious decimal point on fifteen currencies that have none.
 *
 * This delegates to the single currency table so there is one answer.
 */

import { exponentOf, isKnownCurrency } from "./currency";
import { formatMoney, money, type Money } from "./money";

/**
 * Formats a minor-unit amount for display.
 *
 * Unknown currencies fall back to two decimals rather than throwing: this is a
 * display path, and a slightly wrong label is better than a crashed page. Anything
 * that *computes* on the value goes through `money()`, which does throw.
 */
export function formatMinorUnits(
  amount: bigint | number | null | undefined,
  currency: string,
): string | null {
  if (amount === null || amount === undefined) return null;

  const value = typeof amount === "bigint" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return null;

  if (!isKnownCurrency(currency)) return fallbackFormat(value, 2);
  return formatMoney(money(Math.trunc(value), currency));
}

/** Convenience for the common case of formatting a `Money` value. */
export function format(value: Money): string {
  return formatMoney(value);
}

/** Same as `formatMinorUnits`, but returns a dash for absent values. */
export function formatOrDash(
  amount: bigint | number | null | undefined,
  currency: string,
): string {
  return formatMinorUnits(amount, currency) ?? "—";
}

function fallbackFormat(value: number, exponent: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Decimal places for a currency, for callers that need the number itself. */
export function decimalsFor(currency: string): number {
  return isKnownCurrency(currency) ? exponentOf(currency) : 2;
}
