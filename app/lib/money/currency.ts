/**
 * Currency precision.
 *
 * "Minor unit" is not universally 1/100. JPY and KRW have no decimal places at all
 * (a minor unit *is* one yen), and a handful of currencies use three. Getting this
 * wrong produces prices that look broken to local customers — the classic version
 * being a charm-ending profile emitting a fractional yen.
 *
 * Digits follow ISO 4217. This is the subset Shopify supports that we care about;
 * unknown codes fail loudly rather than defaulting to 2, because a silent default
 * is how a JPY store ends up with sub-yen prices.
 */

/** Currencies with no minor unit. A "cent" here is a whole unit. */
const ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
] as const;

/** Currencies with three decimal places. */
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;

const EXPONENTS = new Map<string, number>([
  ...ZERO_DECIMAL.map((c) => [c, 0] as const),
  ...THREE_DECIMAL.map((c) => [c, 3] as const),
]);

/** Two-decimal currencies we explicitly know about. Anything else must be registered. */
const TWO_DECIMAL = [
  "AED", "ARS", "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "COP", "CZK",
  "DKK", "EGP", "EUR", "GBP", "HKD", "HRK", "HUF", "IDR", "ILS", "INR",
  "MXN", "MYR", "NGN", "NOK", "NZD", "PEN", "PHP", "PLN", "RON", "RUB",
  "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "UAH", "USD", "VES", "ZAR",
] as const;

for (const code of TWO_DECIMAL) EXPONENTS.set(code, 2);

export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(
      `Unknown currency "${currency}". Register it in app/lib/money/currency.ts with ` +
        `its ISO 4217 minor-unit exponent. Refusing to guess: defaulting to 2 decimals ` +
        `would emit fractional minor units in zero-decimal currencies such as JPY.`,
    );
    this.name = "UnknownCurrencyError";
  }
}

/** Normalises to an uppercase ISO code without validating it. */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * Minor-unit exponent: 2 for USD (cents), 0 for JPY, 3 for KWD.
 *
 * @throws {UnknownCurrencyError} for unregistered codes.
 */
export function exponentOf(currency: string): number {
  const code = normalizeCurrency(currency);
  const exp = EXPONENTS.get(code);
  if (exp === undefined) throw new UnknownCurrencyError(code);
  return exp;
}

/** Minor units in one major unit: 100 for USD, 1 for JPY, 1000 for KWD. */
export function minorUnitsPerMajor(currency: string): number {
  return 10 ** exponentOf(currency);
}

export function isZeroDecimal(currency: string): boolean {
  return exponentOf(currency) === 0;
}

export function isKnownCurrency(currency: string): boolean {
  return EXPONENTS.has(normalizeCurrency(currency));
}

/** Every registered code. Used by property tests to cover the whole table. */
export function knownCurrencies(): string[] {
  return [...EXPONENTS.keys()].sort();
}
