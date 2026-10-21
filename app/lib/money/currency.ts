/**
 * Currency precision.
 *
 * "Minor unit" is not universally 1/100. JPY and KRW have no decimal places at all
 * (a minor unit *is* one yen), and a handful of currencies use three. Getting this
 * wrong produces prices that look broken to local customers — the classic version
 * being a charm-ending profile emitting a fractional yen.
 *
 * Every `CurrencyCode` in the pinned Admin schema is registered here (#1089), and
 * `currency-schema.test.ts` reads that enum and fails on any code without an entry, so a
 * schema bump cannot reopen the gap. Unknown codes still fail loudly rather than
 * defaulting to 2, because a silent default is how a JPY store ends up with sub-yen
 * prices.
 *
 * Sources, both read on 21 Oct 2026:
 *
 * - ISO 4217 List One (SIX, published 2026-09-17), `CcyMnrUnts`, for every code it lists:
 *   https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 *   List Three for the withdrawal dates of the codes it no longer lists.
 * - Shopify's own money library, which is what Shopify rounds an amount to:
 *   https://github.com/Shopify/money/tree/4d9b0127e5a242a3343d67285a70c328556158eb/config
 *   (`minor_units` is `log10(subunit_to_unit)`, rounded). It agrees with ISO 4217 on every
 *   code both list except MGA and MRU, and it is the only source for the codes ISO does not
 *   list. Where they differ, Shopify wins: a price at a precision Shopify does not store
 *   comes back rounded, and the read-back reports a clean write as a failed one.
 */

/** Currencies with no minor unit, in ISO 4217 and in Shopify. A "cent" here is a whole unit. */
const ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
] as const;

/**
 * Two decimals in ISO 4217, none in Shopify.
 *
 * Both currencies divide into five, not a hundred -- five khoums to the ouguiya, five
 * iraimbilanja to the ariary -- and ISO's "2" is a placeholder for a coin nobody prices
 * in. Shopify treats both as whole units: MRU since 2020, "because the Khoum's value is so
 * small that it's not likely to be relevant in an online transaction" (currency_iso.yml),
 * and MGA since January 2026 (Shopify/money e41169ef77, b262d5c8b1). At ISO's two, a 10%
 * cut on Ar 1,234 is written as 1110.60, Shopify keeps 1111, and the read-back fails.
 */
const WHOLE_UNITS_IN_SHOPIFY = ["MGA", "MRU"] as const;

/** Currencies with three decimal places, in ISO 4217 and in Shopify. */
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;

/** Two decimals in ISO 4217 List One, and in Shopify. */
const TWO_DECIMAL = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN",
  "BZD", "CAD", "CDF", "CHF", "CNY", "COP", "CRC", "CVE", "CZK", "DKK",
  "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL",
  "GHS", "GIP", "GMD", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR",
  "ILS", "INR", "IRR", "JMD", "KES", "KGS", "KHR", "KYD", "KZT", "LAK",
  "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MKD", "MMK", "MNT", "MOP",
  "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK",
  "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR", "RON",
  "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SOS",
  "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS", "TMT", "TOP", "TRY",
  "TTD", "TWD", "TZS", "UAH", "USD", "UYU", "UZS", "VED", "VES", "WST",
  "XCD", "YER", "ZAR", "ZMW",
] as const;

/**
 * Codes the schema lists that ISO 4217 List One does not, at Shopify's precision.
 *
 * Withdrawn currencies stay registered: the schema still offers them, Shopify's money
 * library still carries them, and a store that reports one should be priced at its old
 * precision rather than refused. Each is the precision ISO gave it before withdrawal.
 */
const OUTSIDE_ISO_LIST_ONE: ReadonlyArray<readonly [string, number]> = [
  ["ANG", 2], // withdrawn March 2025 for XCG
  ["BGN", 2], // withdrawn January 2026, when Bulgaria adopted the euro
  ["BYR", 0], // withdrawn January 2017 for BYN; the schema marks it deprecated
  ["HRK", 2], // withdrawn January 2023, when Croatia adopted the euro
  ["LTL", 2], // withdrawn December 2014, when Lithuania adopted the euro
  ["LVL", 2], // withdrawn January 2014, when Latvia adopted the euro
  ["SLL", 2], // withdrawn December 2023 for SLE
  ["STD", 2], // withdrawn December 2017 for STN; the schema marks it deprecated
  ["VEF", 2], // withdrawn August 2018 for VES; the schema marks it deprecated
  ["JEP", 2], // Jersey pound: no ISO code, Shopify's currency_non_iso.yml
  ["KID", 2], // Kiribati dollar: no ISO code, Shopify's currency_non_iso.yml
  ["USDC", 2], // USD Coin: no ISO code, Shopify's crypto.yml
];

/**
 * Codes the schema lists that have no precision at all, and why. A store reporting one is
 * refused, and told so: there is no right number of decimals to price it in.
 */
export const CURRENCIES_WITHOUT_PRECISION: Readonly<Record<string, string>> = {
  XXX:
    "ISO 4217's code for no currency, with no minor unit (List One gives N.A.); the Admin " +
    "schema uses it for a currency Shopify does not recognise.",
};

const EXPONENTS = new Map<string, number>([
  ...ZERO_DECIMAL.map((c) => [c, 0] as const),
  ...WHOLE_UNITS_IN_SHOPIFY.map((c) => [c, 0] as const),
  ...THREE_DECIMAL.map((c) => [c, 3] as const),
  ...TWO_DECIMAL.map((c) => [c, 2] as const),
  ...OUTSIDE_ISO_LIST_ONE,
]);

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
