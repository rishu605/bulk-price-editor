import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { exponentOf, isZeroDecimal, knownCurrencies } from "./currency";
import { formatMoney, money, type Money } from "./money";
import {
  applyRounding,
  charm95,
  charm99,
  defaultProfileFor,
  effectiveProfile,
  InvalidRoundingProfileError,
  NO_ROUNDING,
  validateProfile,
  wholeUnits,
  type RoundingProfile,
} from "./rounding";

const CURRENCIES = knownCurrencies();
const anyCurrency = fc.constantFrom(...CURRENCIES);
const positiveAmount = fc.integer({ min: 1, max: 1_000_000_00 });

const anyProfile: fc.Arbitrary<RoundingProfile> = fc.oneof(
  fc.record({
    mode: fc.constant("charm" as const),
    ending: fc.constantFrom(0, 50, 90, 95, 99),
    direction: fc.constantFrom("up" as const, "down" as const, "nearest" as const),
  }),
  fc.record({
    mode: fc.constant("step" as const),
    step: fc.constantFrom(1, 5, 10, 25, 50, 100),
    direction: fc.constantFrom("up" as const, "down" as const, "nearest" as const),
  }),
);

describe("rounding invariants", () => {
  it("is idempotent: round(round(x)) === round(x)", () => {
    // Directly underpins invariant I2 — a campaign re-planned twice must not drift.
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        const once = applyRounding(money(amount, c), profile);
        const twice = applyRounding(once, profile);
        expect(twice).toEqual(once);
      }),
    );
  });

  it("never emits more precision than the currency allows", () => {
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        const out = applyRounding(money(amount, c), profile);
        expect(Number.isInteger(out.amount)).toBe(true);
        const formatted = formatMoney(out);
        const decimals = formatted.includes(".") ? formatted.split(".")[1].length : 0;
        expect(decimals).toBe(exponentOf(c));
      }),
    );
  });

  it("direction 'down' never increases a price", () => {
    // Load-bearing: it is why clamping must run *after* rounding in the resolver.
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        const down = { ...profile, direction: "down" as const };
        expect(applyRounding(money(amount, c), down).amount).toBeLessThanOrEqual(amount);
      }),
    );
  });

  it("direction 'up' never decreases a price", () => {
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        const up = { ...profile, direction: "up" as const };
        expect(applyRounding(money(amount, c), up).amount).toBeGreaterThanOrEqual(amount);
      }),
    );
  });

  it("'nearest' moves by less than the rounding granularity", () => {
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        const nearest = { ...profile, direction: "nearest" as const };
        const out = applyRounding(money(amount, c), nearest);
        const granularity =
          nearest.mode === "step" ? nearest.step : 10 ** exponentOf(c);
        expect(Math.abs(out.amount - amount)).toBeLessThanOrEqual(granularity);
      }),
    );
  });

  it("preserves currency", () => {
    fc.assert(
      fc.property(anyCurrency, positiveAmount, anyProfile, (c, amount, profile) => {
        expect(applyRounding(money(amount, c), profile).currency).toBe(c);
      }),
    );
  });

  it("NO_ROUNDING is the identity", () => {
    fc.assert(
      fc.property(anyCurrency, positiveAmount, (c, amount) => {
        const m = money(amount, c);
        expect(applyRounding(m, NO_ROUNDING)).toEqual(m);
      }),
    );
  });
});

describe("charm rounding", () => {
  const usd = (n: number): Money => money(n, "USD");

  it("forces the requested ending, picking the genuinely nearest one", () => {
    // 19.47 sits 48c above 18.99 and 52c below 19.99, so "nearest" is 18.99.
    // Merchants who always want to round up should choose direction "up".
    expect(applyRounding(usd(1947), charm99).amount).toBe(1899);
    expect(applyRounding(usd(1980), charm99).amount).toBe(1999);
    expect(applyRounding(usd(1901), charm99).amount).toBe(1899);
    expect(applyRounding(usd(1947), charm95).amount).toBe(1995);
    // 19.47 is 47c above 19.00 and 53c below 20.00.
    expect(applyRounding(usd(1947), wholeUnits).amount).toBe(1900);
    expect(applyRounding(usd(1953), wholeUnits).amount).toBe(2000);
    expect(applyRounding(usd(1947), { ...wholeUnits, direction: "up" }).amount).toBe(2000);
  });

  it("respects direction", () => {
    expect(applyRounding(usd(1947), { ...charm99, direction: "down" }).amount).toBe(1899);
    expect(applyRounding(usd(1947), { ...charm99, direction: "up" }).amount).toBe(1999);
  });

  it("leaves an already-charmed price alone in every direction", () => {
    for (const direction of ["up", "down", "nearest"] as const) {
      expect(applyRounding(usd(1999), { ...charm99, direction }).amount).toBe(1999);
    }
  });

  it("never rounds a non-negative price into a negative one", () => {
    // Regression: candidates for 47c under .99 are [-1, 99, 199], and -1 is
    // arithmetically nearest. Negative candidates are excluded for non-negative input.
    expect(applyRounding(usd(47), charm99).amount).toBe(99);
    expect(applyRounding(usd(0), charm99).amount).toBe(99);
    // No charm price at or below 47c, so "down" clamps to zero rather than
    // increasing the price, which would break the down-monotonic guarantee.
    expect(applyRounding(usd(47), { ...charm99, direction: "down" }).amount).toBe(0);
    expect(applyRounding(usd(47), { ...charm99, direction: "up" }).amount).toBe(99);
  });

  it("never produces a negative price from any non-negative input", () => {
    fc.assert(
      fc.property(
        anyCurrency,
        fc.integer({ min: 0, max: 1_000_000_00 }),
        anyProfile,
        (c, amount, profile) => {
          expect(applyRounding(money(amount, c), profile).amount).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe("zero-decimal degradation (edge case E9)", () => {
  it("degrades a charm profile to step rounding rather than emitting fractional yen", () => {
    const effective = effectiveProfile(charm99, "JPY");
    expect(effective.mode).toBe("step");
    expect(effective).toMatchObject({ mode: "step", step: 1, direction: "nearest" });
  });

  it("preserves the merchant's chosen direction when degrading", () => {
    const up = effectiveProfile({ ...charm99, direction: "up" }, "JPY");
    expect(up.direction).toBe("up");
  });

  it("produces whole yen for every charm profile", () => {
    fc.assert(
      fc.property(positiveAmount, anyProfile, (amount, profile) => {
        const out = applyRounding(money(amount, "JPY"), profile);
        expect(Number.isInteger(out.amount)).toBe(true);
        expect(formatMoney(out)).not.toContain(".");
      }),
    );
  });

  it("still applies step rounding normally in JPY", () => {
    expect(applyRounding(money(1947, "JPY"), { mode: "step", step: 10, direction: "nearest" }).amount)
      .toBe(1950);
    expect(applyRounding(money(1947, "JPY"), { mode: "step", step: 100, direction: "down" }).amount)
      .toBe(1900);
  });

  it("picks a sane default profile per currency", () => {
    expect(defaultProfileFor("USD")).toEqual(charm99);
    expect(defaultProfileFor("JPY").mode).toBe("step");
    for (const c of CURRENCIES) {
      const p = defaultProfileFor(c);
      // Must not throw for any currency in the table.
      expect(() => applyRounding(money(1947, c), p)).not.toThrow();
      if (isZeroDecimal(c)) expect(p.mode).toBe("step");
    }
  });
});

describe("profile validation", () => {
  it("rejects a charm ending that cannot fit below one major unit", () => {
    expect(() => validateProfile({ mode: "charm", ending: 100, direction: "nearest" }, "USD"))
      .toThrow(InvalidRoundingProfileError);
    expect(() => validateProfile({ mode: "charm", ending: 1000, direction: "nearest" }, "KWD"))
      .toThrow(InvalidRoundingProfileError);
    // 999 is legal for a 3-decimal currency
    expect(() => validateProfile({ mode: "charm", ending: 999, direction: "nearest" }, "KWD"))
      .not.toThrow();
  });

  it("rejects non-positive or fractional steps", () => {
    for (const step of [0, -5, 2.5]) {
      expect(() => validateProfile({ mode: "step", step, direction: "nearest" }, "USD"))
        .toThrow(InvalidRoundingProfileError);
    }
  });
});
