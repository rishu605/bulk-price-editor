import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  exponentOf,
  isZeroDecimal,
  knownCurrencies,
  UnknownCurrencyError,
} from "./currency";
import {
  add,
  applyPercentChange,
  clamp,
  CurrencyMismatchError,
  formatMoney,
  money,
  multiplyByFactor,
  NonIntegerMinorUnitsError,
  parseMoney,
  percentOf,
  roundToInteger,
  subtract,
} from "./money";

const CURRENCIES = knownCurrencies();

/** Amounts up to ~10M major units — comfortably past any real product price. */
const anyAmount = fc.integer({ min: -1_000_000_00, max: 1_000_000_00 });
const anyCurrency = fc.constantFrom(...CURRENCIES);
const anyMoney = fc.tuple(anyAmount, anyCurrency).map(([a, c]) => money(a, c));

describe("currency table", () => {
  it("covers at least 20 currencies, as the acceptance criteria require", () => {
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(20);
  });

  it("classifies the currencies that break naive implementations", () => {
    expect(exponentOf("USD")).toBe(2);
    expect(exponentOf("JPY")).toBe(0);
    expect(exponentOf("KRW")).toBe(0);
    expect(exponentOf("BHD")).toBe(3);
    expect(exponentOf("KWD")).toBe(3);
    expect(isZeroDecimal("JPY")).toBe(true);
    expect(isZeroDecimal("USD")).toBe(false);
  });

  it("refuses unknown currencies rather than assuming 2 decimals", () => {
    expect(() => exponentOf("XYZ")).toThrow(UnknownCurrencyError);
  });

  it("is case-insensitive", () => {
    expect(exponentOf("jpy")).toBe(0);
    expect(exponentOf(" usd ")).toBe(2);
  });
});

describe("money construction", () => {
  it("rejects non-integer amounts — the signal that a float leaked in", () => {
    expect(() => money(19.99, "USD")).toThrow(NonIntegerMinorUnitsError);
    expect(() => money(NaN, "USD")).toThrow(NonIntegerMinorUnitsError);
    expect(() => money(Infinity, "USD")).toThrow(NonIntegerMinorUnitsError);
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(100, "USD"), money(100, "EUR"))).toThrow(CurrencyMismatchError);
  });
});

describe("arithmetic properties", () => {
  it("add and subtract are exact inverses", () => {
    fc.assert(
      fc.property(anyMoney, anyAmount, (m, delta) => {
        const other = money(delta, m.currency);
        expect(subtract(add(m, other), other)).toEqual(m);
      }),
    );
  });

  it("addition is commutative and associative", () => {
    fc.assert(
      fc.property(anyCurrency, anyAmount, anyAmount, anyAmount, (c, x, y, z) => {
        const [a, b, d] = [money(x, c), money(y, c), money(z, c)];
        expect(add(a, b)).toEqual(add(b, a));
        expect(add(add(a, b), d)).toEqual(add(a, add(b, d)));
      }),
    );
  });

  it("never produces a non-integer amount, whatever the factor", () => {
    fc.assert(
      fc.property(anyMoney, fc.double({ min: -10, max: 10, noNaN: true }), (m, factor) => {
        expect(Number.isInteger(multiplyByFactor(m, factor).amount)).toBe(true);
      }),
    );
  });

  it("percentOf(m, 100) is m, and percentOf(m, 0) is zero", () => {
    fc.assert(
      fc.property(anyMoney, (m) => {
        expect(percentOf(m, 100)).toEqual(m);
        expect(percentOf(m, 0).amount).toBe(0);
      }),
    );
  });

  it("a -100% change lands exactly on zero", () => {
    fc.assert(
      fc.property(anyMoney, (m) => {
        expect(applyPercentChange(m, -100).amount).toBe(0);
      }),
    );
  });

  it("half-even rounding has no upward bias across exact halves", () => {
    // half-up would return 1,2,3,4,5 (sum 15); half-even returns 0,2,2,4,4 (sum 12).
    const halves = [0.5, 1.5, 2.5, 3.5, 4.5];
    const sum = halves.reduce((n, h) => n + roundToInteger(h, "half-even"), 0);
    expect(sum).toBe(12);
  });

  it("rounds symmetrically about zero", () => {
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (v) => {
        for (const mode of ["half-even", "half-up", "half-down"] as const) {
          expect(roundToInteger(-v, mode)).toBe(-roundToInteger(v, mode));
        }
      }),
    );
  });
});

describe("clamp", () => {
  it("always lands within the bounds", () => {
    fc.assert(
      fc.property(anyCurrency, anyAmount, anyAmount, anyAmount, (c, v, b1, b2) => {
        const lower = money(Math.min(b1, b2), c);
        const upper = money(Math.max(b1, b2), c);
        const out = clamp(money(v, c), lower, upper);
        expect(out.amount).toBeGreaterThanOrEqual(lower.amount);
        expect(out.amount).toBeLessThanOrEqual(upper.amount);
      }),
    );
  });
});

describe("parse and format", () => {
  it("round-trips through a string without loss", () => {
    fc.assert(
      fc.property(anyMoney, (m) => {
        expect(parseMoney(formatMoney(m), m.currency)).toEqual(m);
      }),
    );
  });

  it("parses the values Shopify actually returns", () => {
    expect(parseMoney("19.99", "USD").amount).toBe(1999);
    expect(parseMoney("19.90", "USD").amount).toBe(1990);
    expect(parseMoney("19", "USD").amount).toBe(1900);
    expect(parseMoney("1980", "JPY").amount).toBe(1980);
    expect(parseMoney("19.999", "KWD").amount).toBe(19999);
    expect(parseMoney("-4.50", "USD").amount).toBe(-450);
  });

  it("avoids the float trap that motivates this module", () => {
    // parseFloat("19.99") * 100 === 1998.9999999999998
    expect(parseMoney("19.99", "USD").amount).toBe(1999);
    expect(parseMoney("0.29", "USD").amount).toBe(29);
    expect(parseMoney("1.005", "KWD").amount).toBe(1005);
  });

  it("formats without a decimal point in zero-decimal currencies", () => {
    expect(formatMoney(money(1980, "JPY"))).toBe("1980");
    expect(formatMoney(money(1999, "USD"))).toBe("19.99");
    expect(formatMoney(money(5, "USD"))).toBe("0.05");
    expect(formatMoney(money(19999, "KWD"))).toBe("19.999");
  });

  it("rejects more precision than the currency allows", () => {
    expect(() => parseMoney("19.999", "USD")).toThrow(RangeError);
    expect(() => parseMoney("1980.5", "JPY")).toThrow(RangeError);
    // but insignificant trailing zeros are fine
    expect(parseMoney("19.9900", "USD").amount).toBe(1999);
    expect(parseMoney("1980.00", "JPY").amount).toBe(1980);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "1.2.3", "1,99", "$19.99", "1e3"]) {
      expect(() => parseMoney(bad, "USD")).toThrow(RangeError);
    }
  });
});
