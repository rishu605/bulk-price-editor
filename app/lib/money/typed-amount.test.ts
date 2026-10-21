/**
 * An amount a merchant types, read exactly or refused by name (#1068).
 *
 * `Math.round(9.995 * 100)` is `Math.round(999.4999999999999)`, so "Set exact price 9.995"
 * saved 9.99 while 4.355 saved 4.36 — the same half cent either way, decided by which side
 * of it the nearest double fell. Every form that takes money now reads the text it was
 * given, and refuses what the currency cannot hold rather than rounding it.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";
import { storedMajorUnits, typedAmount } from "./typed-amount";

describe("reading a typed amount", () => {
  it.each([
    ["9.995", "USD", 999, 1_000],
    ["1.005", "USD", 100, 101],
    ["4.355", "USD", 435, 436],
    ["0.145", "USD", 14, 15],
  ])("refuses %s %s, whichever side of the half cent its float falls", (typed, currency, below, above) => {
    const read = typedAmount("The price", typed, currency);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const [lo, hi] = [below, above].map((minor) => (minor / 100).toFixed(2));
    expect(read.message).toBe(
      `The price ${typed} has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as ${lo} or ${hi}.`,
    );
  });

  it("names a zero-decimal currency's rule as a whole number", () => {
    expect(typedAmount("The price", "1500.5", "JPY")).toEqual({
      ok: false,
      message: "The price 1500.5 has 1 decimal place, but JPY has none. Enter a whole number, such as 1500 or 1501.",
    });
  });

  it("allows a three-decimal currency its third decimal, and refuses a fourth", () => {
    expect(typedAmount("The price", "1.005", "KWD")).toEqual({ ok: true, amount: { amount: 1_005, currency: "KWD" } });
    expect(typedAmount("The price", "1.0005", "KWD")).toEqual({
      ok: false,
      message: "The price 1.0005 has 4 decimal places, but KWD has 3. Enter it to 3 decimal places, such as 1.000 or 1.001.",
    });
  });

  it.each([
    ["9.99", "USD", 999],
    ["1500", "JPY", 1_500],
    ["9.9900", "USD", 999],
    ["1500.000", "JPY", 1_500],
    ["0.29", "USD", 29],
    [".5", "USD", 50],
    ["5.", "USD", 500],
    ["+3", "USD", 300],
    ["-4.35", "USD", -435],
    [" 12.5 ", "EUR", 1_250],
  ])("reads %s %s as exactly %i minor units", (typed, currency, minor) => {
    expect(typedAmount("The price", typed, currency)).toEqual({ ok: true, amount: { amount: minor, currency } });
  });

  it("refuses what is not a plain amount, rather than letting Number read it", () => {
    for (const typed of ["1e3", "0x10", "", ".", "-", "1.2.3", "12,50"]) {
      const read = typedAmount("The price", typed, "USD");
      expect(read.ok, typed).toBe(false);
      if (read.ok) continue;
      expect(read.message, typed).toMatch(/is not a plain amount\. Enter digits with a full stop for decimals, such as 12\.50\.$/);
    }
    expect(typedAmount("The price", "1e3", "JPY")).toMatchObject({ message: expect.stringMatching(/such as 1250\.$/) });
  });

  it("names the neighbours on the right side of a negative amount", () => {
    expect(typedAmount("The amount", "-9.995", "USD")).toMatchObject({
      message: expect.stringMatching(/such as -10\.00 or -9\.99\.$/),
    });
  });
});

describe("reading a stored major-unit amount", () => {
  it("is exact for every amount the currency can hold", () => {
    expect(storedMajorUnits(9.99, "USD", "ceil")).toEqual({ amount: 999, currency: "USD" });
    expect(storedMajorUnits(0.29, "USD", "ceil")).toEqual({ amount: 29, currency: "USD" });
    expect(storedMajorUnits(1_500, "JPY", "ceil")).toEqual({ amount: 1_500, currency: "JPY" });
    expect(storedMajorUnits(1.005, "KWD", "ceil")).toEqual({ amount: 1_005, currency: "KWD" });
  });

  it("rounds past the currency's decimals once, on the exact decimal, by the mode it is given", () => {
    expect(storedMajorUnits(9.995, "USD", "ceil").amount).toBe(1_000);
    expect(storedMajorUnits(9.995, "USD", "floor").amount).toBe(999);
    expect(storedMajorUnits(0.145, "USD", "half-up").amount).toBe(15);
  });
});

describe("no typed amount is converted by multiplying a float", () => {
  const FLOAT_TIMES_SCALE = [/Math\.round\(.*\*\s*perMajor\s*\)/, /Math\.round\(.*\*\s*10\s*\*\*\s*decimalsFor\(/];
  const offences = (source: string) => FLOAT_TIMES_SCALE.filter((pattern) => pattern.test(source)).map(String);

  it("catches the lines it was written for", () => {
    // The three sites #1068 named. A guard that cannot match them passes for the wrong reason.
    expect(offences("amount: money(Math.round(signedAmount(read) * perMajor), currency),")).not.toEqual([]);
    expect(offences('return { kind: "set-exact", amount: money(Math.round(value * perMajor), currency) };')).not.toEqual([]);
    expect(offences(": money(Math.round(settings.minPrice * 10 ** decimalsFor(currency)), currency),")).not.toEqual([]);
  });

  const files = sourceFiles("app").filter((file) => !file.startsWith("app/lib/money/"));

  it("found the tree, so this is not passing over an empty list", () => {
    expect(files).toContain("app/lib/campaigns/draft-form.ts");
    expect(files).toContain("app/services/settings.server.ts");
  });

  it.each(files)("%s reads typed money from its text", (file) => {
    expect(offences(sourceOf(file))).toEqual([]);
  });
});
