/**
 * Money in integer minor units.
 *
 * Floats are banned anywhere near a price. `0.1 + 0.2 !== 0.3`, and a fraction of a
 * cent multiplied across 150,000 variants becomes a real conversation with a
 * merchant's accountant. Every value here is an integer count of minor units
 * (cents for USD, whole yen for JPY) paired with its currency.
 *
 * Percentage and factor operations necessarily involve non-integer maths. They are
 * confined to this module, done in a widened integer domain, and always land back on
 * an integer via an explicit, documented rounding step — never left to float drift.
 */

import { exponentOf, normalizeCurrency } from "./currency";

export interface Money {
  /** Integer count of minor units. May be negative; callers decide if that is legal. */
  readonly amount: number;
  /** ISO 4217, uppercase. */
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} with ${b}. Money operations require a single currency.`);
    this.name = "CurrencyMismatchError";
  }
}

export class NonIntegerMinorUnitsError extends Error {
  constructor(amount: number) {
    super(
      `Money amount must be an integer number of minor units, got ${amount}. ` +
        `This usually means a float leaked into a price calculation.`,
    );
    this.name = "NonIntegerMinorUnitsError";
  }
}

/** Constructs Money, rejecting non-integer or non-finite amounts. */
export function money(amount: number, currency: string): Money {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new NonIntegerMinorUnitsError(amount);
  }
  const code = normalizeCurrency(currency);
  exponentOf(code); // throws UnknownCurrencyError for unregistered codes
  // `amount + 0` normalises -0 to 0. Negative zero arises naturally from e.g.
  // percentOf(negativeAmount, 0), and although -0 === 0, Object.is(-0, 0) is false —
  // so it silently breaks deep-equality checks in tests, caches and ledger diffs.
  return { amount: amount + 0, currency: code };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

// ---------------------------------------------------------------- arithmetic

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function abs(a: Money): Money {
  return money(Math.abs(a.amount), a.currency);
}

/**
 * Rounding for the intermediate results of percentage and factor maths.
 *
 * `half-even` (banker's rounding) is the default because it has no systematic bias:
 * `half-up` would nudge every exact-half result upward, and applied across a large
 * catalogue that is a real, one-directional drift in the merchant's favour that
 * nobody asked for. Campaign-level rounding profiles are applied separately and
 * deliberately on top of this (see ./rounding).
 */
export type IntermediateRounding = "half-even" | "half-up" | "half-down" | "floor" | "ceil";

export function roundToInteger(value: number, mode: IntermediateRounding = "half-even"): number {
  if (Number.isInteger(value)) return value;

  switch (mode) {
    case "floor":
      return Math.floor(value);
    case "ceil":
      return Math.ceil(value);
    case "half-up":
      // Math.round breaks ties toward +Infinity, which is asymmetric for negatives.
      return Math.sign(value) * Math.round(Math.abs(value));
    case "half-down": {
      const a = Math.abs(value);
      const f = Math.floor(a);
      const frac = a - f;
      return Math.sign(value) * (frac > 0.5 ? f + 1 : f);
    }
    case "half-even": {
      const a = Math.abs(value);
      const f = Math.floor(a);
      const frac = a - f;
      let r: number;
      if (frac > 0.5) r = f + 1;
      else if (frac < 0.5) r = f;
      else r = f % 2 === 0 ? f : f + 1;
      return Math.sign(value) * r;
    }
  }
}

/** Multiplies by a factor (1.15 marks up 15%), landing back on an integer. */
export function multiplyByFactor(
  a: Money,
  factor: number,
  mode: IntermediateRounding = "half-even",
): Money {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`Factor must be finite, got ${factor}`);
  }
  return money(roundToInteger(a.amount * factor, mode), a.currency);
}

/** `percentOf(m, 20)` → 20% of m. Negative percentages are allowed. */
export function percentOf(
  a: Money,
  percent: number,
  mode: IntermediateRounding = "half-even",
): Money {
  if (!Number.isFinite(percent)) {
    throw new RangeError(`Percent must be finite, got ${percent}`);
  }
  return money(roundToInteger((a.amount * percent) / 100, mode), a.currency);
}

/** `applyPercentChange(m, -20)` → m reduced by 20%. */
export function applyPercentChange(
  a: Money,
  percentChange: number,
  mode: IntermediateRounding = "half-even",
): Money {
  return multiplyByFactor(a, 1 + percentChange / 100, mode);
}

// ---------------------------------------------------------------- comparison

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export const equals = (a: Money, b: Money) => compare(a, b) === 0;
export const lessThan = (a: Money, b: Money) => compare(a, b) === -1;
export const greaterThan = (a: Money, b: Money) => compare(a, b) === 1;
export const lessThanOrEqual = (a: Money, b: Money) => compare(a, b) <= 0;
export const greaterThanOrEqual = (a: Money, b: Money) => compare(a, b) >= 0;

export const isZero = (a: Money) => a.amount === 0;
export const isNegative = (a: Money) => a.amount < 0;
export const isPositive = (a: Money) => a.amount > 0;

export function min(a: Money, b: Money): Money {
  return lessThanOrEqual(a, b) ? a : b;
}

export function max(a: Money, b: Money): Money {
  return greaterThanOrEqual(a, b) ? a : b;
}

/** Constrains to [lower, upper]; either bound may be omitted. */
export function clamp(value: Money, lower?: Money, upper?: Money): Money {
  let out = value;
  if (lower) out = max(out, lower);
  if (upper) out = min(out, upper);
  return out;
}

// ------------------------------------------------------------ parse / format

/**
 * Parses a decimal string as Shopify returns it ("19.99", "1980", "-4.50").
 *
 * Deliberately string-based: `parseFloat("19.99") * 100` is 1998.9999999999998, and
 * the whole point of this module is that such a number never exists.
 *
 * @throws {RangeError} if the string carries more precision than the currency allows.
 */
export function parseMoney(value: string, currency: string): Money {
  const code = normalizeCurrency(currency);
  const exp = exponentOf(code);
  const trimmed = value.trim();

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new RangeError(`Cannot parse "${value}" as a ${code} amount.`);

  const [, sign, whole, fraction = ""] = match;

  if (fraction.length > exp) {
    // Trailing zeros carry no value, so "19.9900" is fine for a 2-decimal currency.
    const significant = fraction.replace(/0+$/, "");
    if (significant.length > exp) {
      throw new RangeError(
        `"${value}" has ${significant.length} decimal places but ${code} allows ${exp}.`,
      );
    }
  }

  const padded = (fraction + "0".repeat(exp)).slice(0, exp);
  const amount = Number(whole) * 10 ** exp + (exp > 0 ? Number(padded || "0") : 0);
  return money(sign ? -amount : amount, code);
}

/** Formats as a plain decimal string for the Admin API ("19.99", "1980"). */
export function formatMoney(m: Money): string {
  const exp = exponentOf(m.currency);
  const negative = m.amount < 0;
  const digits = Math.abs(m.amount).toString().padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp) || "0";
  const fraction = exp > 0 ? "." + digits.slice(digits.length - exp) : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Human-readable, locale-aware. For UI only — never for API payloads. */
export function formatMoneyForDisplay(m: Money, locale = "en-US"): string {
  const exp = exponentOf(m.currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(m.amount / 10 ** exp);
}
