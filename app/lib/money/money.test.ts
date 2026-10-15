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
  exactDecimal,
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

describe("a percentage or factor is exact on minor units (#1051)", () => {
  const usd = (n: number) => money(n, "USD");
  const MODES = ["half-even", "half-up", "half-down", "floor", "ceil"] as const;

  /**
   * Whether `r` is `n / d` rounded by `mode`, for a positive `d`. A description of each
   * rounding by what it guarantees, on BigInt, not a second implementation of it.
   */
  function roundsTo(r: bigint, n: bigint, d: bigint, mode: (typeof MODES)[number]): boolean {
    const off = r * d - n; // how far r is from n/d, times d
    const twiceOff = 2n * (off < 0n ? -off : off);
    const away = (r < 0n ? -r : r) * d > (n < 0n ? -n : n); // r is further from zero than n/d
    switch (mode) {
      case "floor":
        return off <= 0n && off > -d;
      case "ceil":
        return off >= 0n && off < d;
      case "half-even":
        return twiceOff < d || (twiceOff === d && r % 2n === 0n);
      case "half-up":
        return twiceOff < d || (twiceOff === d && away);
      case "half-down":
        return twiceOff < d || (twiceOff === d && !away);
    }
  }

  it("rounds an exact half cent by the rule, not by float error", () => {
    // 12.85 × 0.7 is exactly 8.995, which half-even makes 9.00. The double 0.7 is a hair
    // under 0.7, so the product was 899.4999999999999, half-even never saw a tie, and 8.99
    // reached the storefront. At −30% every such tie went down.
    expect(applyPercentChange(usd(1_285), -30)).toEqual(usd(900));
    expect(applyPercentChange(usd(1_325), -30)).toEqual(usd(928));
    // 0.25 × 1.14 is exactly 0.285: half-even keeps the even 0.28. `1 + 14/100` is a hair
    // over 1.14, which made it 0.29.
    expect(applyPercentChange(usd(25), 14)).toEqual(usd(28));
  });

  it("does the same in a currency with no minor unit", () => {
    // ¥1,285 at 30% off is exactly ¥899.5, and ¥25 up 14% is exactly ¥28.5.
    expect(applyPercentChange(money(1_285, "JPY"), -30)).toEqual(money(900, "JPY"));
    expect(applyPercentChange(money(25, "JPY"), 14)).toEqual(money(28, "JPY"));
  });

  it("reads a fractional percent as the decimal it prints as", () => {
    // 1.40 at 82.5% off is exactly 0.245, and 0.60 at 82.5% off exactly 0.105. The float
    // factor made both a hair over the half and rounded them up.
    expect(applyPercentChange(usd(140), -82.5)).toEqual(usd(24));
    expect(applyPercentChange(usd(60), -82.5)).toEqual(usd(10));
    expect(percentOf(usd(125), 64.4)).toEqual(usd(80)); // exactly 0.805
    expect(percentOf(usd(375), 4.4)).toEqual(usd(16)); // exactly 0.165
  });

  it("multiplies by a factor exactly", () => {
    expect(multiplyByFactor(usd(50), 1.15)).toEqual(usd(58)); // exactly 0.575
    expect(multiplyByFactor(usd(15), 4.1)).toEqual(usd(62)); // exactly 0.615
    expect(multiplyByFactor(usd(25), 2.18)).toEqual(usd(54)); // exactly 0.545
  });

  it("rounds an exact tie the way each mode says, symmetrically about zero", () => {
    // 8.995 and −8.995: the tie each mode exists to decide.
    const cases: Array<[(typeof MODES)[number], number]> = [
      ["half-even", 900],
      ["half-up", 900],
      ["half-down", 899],
      ["floor", 899],
      ["ceil", 900],
    ];
    for (const [mode, expected] of cases) {
      expect(applyPercentChange(usd(1_285), -30, mode).amount, mode).toBe(expected);
    }
    expect(applyPercentChange(usd(-1_285), -30, "half-even").amount).toBe(-900);
    expect(applyPercentChange(usd(-1_285), -30, "half-up").amount).toBe(-900);
    expect(applyPercentChange(usd(-1_285), -30, "half-down").amount).toBe(-899);
    expect(applyPercentChange(usd(-1_285), -30, "floor").amount).toBe(-900);
    expect(applyPercentChange(usd(-1_285), -30, "ceil").amount).toBe(-899);
  });

  it("reads a number as the decimal it prints as, whatever notation it prints in", () => {
    const read = (value: number) => {
      const { numerator, denominator } = exactDecimal(value);
      return `${numerator}/${denominator}`;
    };
    expect(read(0.7)).toBe("7/10");
    expect(read(-82.5)).toBe("-825/10");
    expect(read(12.3456)).toBe("123456/10000");
    expect(read(-30)).toBe("-30/1");
    // Below 1e-6 and from 1e21 up, `String` switches to exponent notation.
    expect(read(1.5e-7)).toBe("15/100000000");
    expect(read(-2e-7)).toBe("-2/10000000");
    expect(read(1.5e21)).toBe("1500000000000000000000/1");
    // A sum that is not the decimal it looks like is read as the double it is, not guessed at.
    expect(read(0.1 + 0.2)).toBe("30000000000000004/100000000000000000");
    expect(multiplyByFactor(money(10_000_000, "USD"), 1.5e-7, "ceil").amount).toBe(2); // 1.5 → 2
    expect(multiplyByFactor(money(10_000_000, "USD"), 1.5e-7, "floor").amount).toBe(1);
  });

  it("refuses a percent or factor that is not a finite number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => applyPercentChange(usd(100), bad)).toThrow(RangeError);
      expect(() => multiplyByFactor(usd(100), bad)).toThrow(RangeError);
      expect(() => percentOf(usd(100), bad)).toThrow(RangeError);
    }
  });

  it("is exact half-even for every cent to 100.00 at every whole percent from −99 to +200", () => {
    // 3M pairs. The exact price is amount × (100 + p) / 100, checked by cross-multiplying
    // on integers small enough to be exact in a double.
    const failures: string[] = [];
    for (let amount = 1; amount <= 10_000; amount += 1) {
      for (let percent = -99; percent <= 200; percent += 1) {
        const exact = amount * (100 + percent);
        const price = applyPercentChange(usd(amount), percent).amount;
        const twiceOff = 2 * Math.abs(price * 100 - exact);
        if (!(twiceOff < 100 || (twiceOff === 100 && price % 2 === 0))) {
          failures.push(`${amount} at ${percent}% → ${price}`);
        }
      }
    }
    expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
  }, 30_000);

  it("is exact half-even at every tenth of a percent from −99.9 to +100", () => {
    // 2.9M pairs: every seventh cent to 100.00. A tenth of a percent is `t / 1000`, so the
    // exact price is amount × (1000 + t) / 1000.
    const failures: string[] = [];
    for (let amount = 1; amount <= 10_000; amount += 7) {
      for (let tenths = -999; tenths <= 1_000; tenths += 1) {
        const exact = amount * (1_000 + tenths);
        const price = applyPercentChange(usd(amount), tenths / 10).amount;
        const twiceOff = 2 * Math.abs(price * 1_000 - exact);
        if (!(twiceOff < 1_000 || (twiceOff === 1_000 && price % 2 === 0))) {
          failures.push(`${amount} at ${tenths / 10}% → ${price}`);
        }
      }
    }
    expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
  }, 30_000);

  it("is exact half-even for every cent to 100.00 times every two-decimal factor to 5.00", () => {
    // 5M pairs: a factor of h / 100, so the exact price is amount × h / 100.
    const failures: string[] = [];
    for (let amount = 1; amount <= 10_000; amount += 1) {
      for (let hundredths = 1; hundredths <= 500; hundredths += 1) {
        const exact = amount * hundredths;
        const price = multiplyByFactor(usd(amount), hundredths / 100).amount;
        const twiceOff = 2 * Math.abs(price * 100 - exact);
        if (!(twiceOff < 100 || (twiceOff === 100 && price % 2 === 0))) {
          failures.push(`${amount} × ${hundredths / 100} → ${price}`);
        }
      }
    }
    expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
  }, 30_000);

  /**
   * A decimal with up to four places: the number a merchant typing it would hold, and the
   * exact value it was typed as, `digits / scale`.
   */
  const anyDecimal = (maxWhole: number) =>
    fc
      .tuple(
        fc.integer({ min: -maxWhole * 10_000, max: maxWhole * 10_000 }),
        fc.integer({ min: 0, max: 4 }),
      )
      .map(([units, places]) => {
        const digits = BigInt(units) / 10n ** BigInt(4 - places);
        return { value: Number(`${digits}e-${places}`), digits, scale: 10n ** BigInt(places) };
      });

  const anyMinorUnits = fc.integer({ min: -10_000_000_000, max: 10_000_000_000 });

  it("property: a percent change is the exact rational, rounded once by the mode asked", () => {
    fc.assert(
      fc.property(anyMinorUnits, anyDecimal(300), fc.constantFrom(...MODES), (amount, percent, mode) => {
        const price = applyPercentChange(usd(amount), percent.value, mode).amount;
        const whole = 100n * percent.scale;
        const n = BigInt(amount) * (whole + percent.digits);
        expect(roundsTo(BigInt(price), n, whole, mode)).toBe(true);
      }),
      { numRuns: 20_000 },
    );
  });

  it("property: a factor and a share are the exact rational, rounded once by the mode asked", () => {
    fc.assert(
      fc.property(anyMinorUnits, anyDecimal(10), fc.constantFrom(...MODES), (amount, factor, mode) => {
        const product = multiplyByFactor(usd(amount), factor.value, mode).amount;
        expect(roundsTo(BigInt(product), BigInt(amount) * factor.digits, factor.scale, mode)).toBe(true);

        const share = percentOf(usd(amount), factor.value, mode).amount;
        expect(
          roundsTo(BigInt(share), BigInt(amount) * factor.digits, 100n * factor.scale, mode),
        ).toBe(true);
      }),
      { numRuns: 20_000 },
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
