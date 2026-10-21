/**
 * Money a merchant typed, read from the text into minor units, or refused by name (#1068).
 *
 * Every form that takes an amount -- the campaign editor's exact price and fixed change,
 * the bulk cost form, the minimum-price guardrail -- turned it into minor units with
 * `Math.round(Number(typed) * perMajor)`. `9.995 * 100` is 999.4999999999999, so 9.995 saved
 * 9.99 while 4.355 saved 4.36: the same half cent rounded either way, decided by which side
 * of it the nearest double fell, and nothing said the third decimal was not a price.
 *
 * So the text is read as text, as `parseMoney` reads what Shopify sends, and an amount with
 * more decimals than its currency has is refused rather than rounded. Rounding it either
 * way is a price the merchant did not type; the refusal names both neighbours so choosing
 * one is a keystroke.
 *
 * Client-safe: the campaign editor's preview and the cost page read their fields with it.
 */

import { exponentOf, normalizeCurrency } from "./currency";
import {
  divideRounded,
  exactDecimal,
  formatMoney,
  money,
  parseMoney,
  scaleExactly,
  type IntermediateRounding,
  type Money,
} from "./money";

export type TypedAmount = { ok: true; amount: Money } | { ok: false; message: string };

/**
 * Digits, an optional sign, and at most one full stop: "9.99", "-10", ".5", "5.".
 *
 * Narrower than `Number` on purpose. `Number` also takes "1e3", "0x10" and "0b11", and a
 * price box that reads "1e3" as a thousand is not reading what the merchant sees.
 */
const PLAIN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * The amount `typed` names in `currency`, exactly, or the sentence refusing it.
 *
 * `label` is the field as the merchant knows it ("The exact price", "Minimum price (USD)"),
 * because the refusal is shown beside or about that field and has to say which one.
 *
 * @throws {UnknownCurrencyError} for an unregistered currency, as `money` does.
 */
export function typedAmount(label: string, typed: string, currency: string): TypedAmount {
  const code = normalizeCurrency(currency);
  const allowed = exponentOf(code);
  const shown = typed.trim();

  const parts = PLAIN.exec(shown);
  if (!parts || !/\d/.test(shown)) {
    return {
      ok: false,
      message: `${label} ${shown} is not a plain amount. Enter digits with a full stop for decimals, such as ${example(allowed)}.`,
    };
  }

  const [, sign = "", whole = "", fraction = ""] = parts;
  // Trailing zeros carry no value: 9.990 is a dollar amount, and so is 1500.000 yen.
  const places = fraction.replace(/0+$/, "").length;

  if (places > allowed) {
    // The two amounts either side of what was typed, worked out on the exact decimal.
    const exact = BigInt(`${sign === "-" ? "-" : ""}${whole || "0"}${fraction}`) * 10n ** BigInt(allowed);
    const scale = 10n ** BigInt(fraction.length);
    const [lo, hi] = (["floor", "ceil"] as const).map((mode) =>
      formatMoney(money(Number(divideRounded(exact, scale, mode)), code)),
    );
    const had = `${places} decimal ${places === 1 ? "place" : "places"}`;
    return {
      ok: false,
      message:
        allowed === 0
          ? `${label} ${shown} has ${had}, but ${code} has none. Enter a whole number, such as ${lo} or ${hi}.`
          : `${label} ${shown} has ${had}, but ${code} has ${allowed}. ` +
            `Enter it to ${allowed} decimal ${allowed === 1 ? "place" : "places"}, such as ${lo} or ${hi}.`,
    };
  }

  const text = `${sign === "-" ? "-" : ""}${whole || "0"}${fraction ? `.${fraction}` : ""}`;
  return { ok: true, amount: parseMoney(text, code) };
}

/**
 * A major-unit amount as stored -- the minimum-price guardrail keeps the number the merchant
 * typed -- in minor units.
 *
 * Read as the decimal it prints as (`exactDecimal`), so 9.99 is 999 and not a float a hair
 * either side of it. That is exact for every amount the currency can hold, which is all a
 * save now accepts. One saved before #1068 may have more decimals; `mode` rounds it once,
 * on the exact decimal, and the caller chooses which way is safe.
 */
export function storedMajorUnits(value: number, currency: string, mode: IntermediateRounding): Money {
  const code = normalizeCurrency(currency);
  const { numerator, denominator } = exactDecimal(value, "A stored amount");
  return scaleExactly(money(10 ** exponentOf(code), code), numerator, denominator, mode);
}

/** "12.50" in dollars, "12.500" in dinar, "1250" in yen: a plain amount as it is typed. */
function example(decimals: number): string {
  return decimals === 0 ? "1250" : `12.${"5".padEnd(decimals, "0")}`;
}
