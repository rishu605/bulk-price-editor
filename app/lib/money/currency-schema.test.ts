/**
 * Every currency the pinned Admin schema can name has a precision (#1089).
 *
 * The table registered 63 of the schema's 162 `CurrencyCode` values, and `exponentOf` throws
 * for the rest by design -- so a store selling in Qatari riyal, Pakistani rupee or Kenyan
 * shilling read every price as an `UnknownCurrencyError` and could not sync at all. The list
 * here is read from the schema itself, not from memory, so a schema bump that adds a code
 * fails this test until somebody gives that code its minor unit.
 */

import { describe, expect, it } from "vitest";

import { API_VERSION_STRING } from "../shopify/api-version";
import { rawSource, sourceOf } from "../testing/source";
import {
  CURRENCIES_WITHOUT_PRECISION,
  exponentOf,
  isKnownCurrency,
  UnknownCurrencyError,
} from "./currency";
import { formatPrice } from "./format";
import { formatMoney, money, parseMoney } from "./money";
import { applyRounding, charm99, defaultProfileFor } from "./rounding";

/** `CurrencyCode` in the introspected schema of the version the app speaks. JSON, so read raw. */
function pinnedSchemaCodes(): string[] {
  const schema = JSON.parse(rawSource("app", "types", `admin-${API_VERSION_STRING}.schema.json`)) as {
    __schema: { types: Array<{ name: string; enumValues?: Array<{ name: string }> | null }> };
  };
  const type = schema.__schema.types.find((candidate) => candidate.name === "CurrencyCode");
  return (type?.enumValues ?? []).map((value) => value.name);
}

/** `enum CurrencyCode` as codegen wrote it from that schema, which is what the code is typed by. */
function generatedCodes(): string[] {
  const source = sourceOf("app", "types", "admin.types.d.ts");
  const body = /export enum CurrencyCode \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  return [...body.matchAll(/=\s*'([A-Z0-9]+)'/g)].map((match) => match[1]);
}

const SCHEMA = [...new Set([...pinnedSchemaCodes(), ...generatedCodes()])].sort();
const PRICEABLE = SCHEMA.filter((code) => !(code in CURRENCIES_WITHOUT_PRECISION));

describe("the currency table against the pinned Admin schema", () => {
  it("reads the schema's CurrencyCode enum, so an empty read cannot pass vacuously", () => {
    // 162 in 2026-07. A parse that found none would make every check below true.
    expect(pinnedSchemaCodes().length).toBeGreaterThan(150);
    expect(generatedCodes().sort()).toEqual(pinnedSchemaCodes().sort());
  });

  it("gives every code the schema lists a minor unit, or a stated reason it has none", () => {
    const missing = PRICEABLE.filter((code) => !isKnownCurrency(code));
    expect(missing, `register these in app/lib/money/currency.ts with their minor units`).toEqual([]);
  });

  it("says why a code has no precision only for codes that really have none", () => {
    for (const [code, reason] of Object.entries(CURRENCIES_WITHOUT_PRECISION)) {
      expect(isKnownCurrency(code), `${code} is both priceable and not`).toBe(false);
      expect(() => exponentOf(code)).toThrow(UnknownCurrencyError);
      expect(reason.length, `${code} has no reason`).toBeGreaterThan(20);
    }
    // XXX is ISO 4217's "no currency is involved": nothing to count minor units of.
    expect(Object.keys(CURRENCIES_WITHOUT_PRECISION)).toEqual(["XXX"]);
  });

  it("has the precision ISO 4217 and Shopify give the currencies that are not two decimals", () => {
    // Two decimals: the ticket's examples, and a withdrawn code a store may still report.
    for (const code of ["QAR", "PKR", "KES", "MAD", "LTL", "VEF", "STD", "JEP", "KID", "USDC"]) {
      expect(exponentOf(code), code).toBe(2);
    }
    // No decimals. BYR was withdrawn at 0. MGA and MRU are 2 in ISO 4217 -- a placeholder
    // for a fifth-of-a-unit coin -- and 0 in Shopify, which is what a price can be stored at.
    for (const code of ["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "PYG", "BYR", "MGA", "MRU"]) {
      expect(exponentOf(code), code).toBe(0);
    }
    for (const code of ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]) {
      expect(exponentOf(code), code).toBe(3);
    }
  });

  it.each(PRICEABLE)("reads, writes, formats and rounds %s", (code) => {
    const exponent = exponentOf(code);
    const typed = exponent === 0 ? "1234" : `12.${"3".repeat(exponent)}`;
    const amount = parseMoney(typed, code);
    expect(formatMoney(amount)).toBe(typed);

    // A price a merchant reads names its currency, whether or not Intl has a symbol for it.
    expect(formatPrice(amount.amount, code)).toMatch(/\d/);
    expect(formatPrice(amount.amount, code)).not.toBe(String(amount.amount));

    // Rounding lands on a whole minor unit of this currency, and never on a fraction of one.
    const rounded = applyRounding(money(123_456, code), defaultProfileFor(code));
    expect(Number.isInteger(rounded.amount)).toBe(true);
    expect(Number.isInteger(applyRounding(money(123_456, code), charm99).amount)).toBe(true);
  });
});
