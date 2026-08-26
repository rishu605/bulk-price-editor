/**
 * What "verified" is allowed to mean.
 *
 * The bug this exists to prevent: Shopify accepts a mutation, stores something else, and
 * the run reports clean while the storefront is wrong. Every case here is a way that can
 * happen without a single error being returned.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { parseObserved, readBackVerdict } from "./read-back";

const usd = (minor: number) => money(minor, "USD");
const jpy = (minor: number) => money(minor, "JPY");
const kwd = (minor: number) => money(minor, "KWD");

describe("a row is verified only when the prices match", () => {
  it("passes when Shopify stored what we asked for", () => {
    const verdict = readBackVerdict(usd(1999), "19.99");

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.observed).toEqual(usd(1999));
  });

  it("fails when Shopify stored something else", () => {
    const verdict = readBackVerdict(usd(1999), "24.99");

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.observed).toEqual(usd(2499));
  });

  it("fails on a difference of a single minor unit", () => {
    // A cent is not a rounding detail: it is the difference between the price a merchant
    // approved and a price they did not.
    expect(readBackVerdict(usd(1999), "20.00").ok).toBe(false);
  });

  it("names both numbers, because support reads this", () => {
    const verdict = readBackVerdict(usd(1999), "24.99");

    expect(verdict.ok === false && verdict.reason).toContain("19.99");
    expect(verdict.ok === false && verdict.reason).toContain("24.99");
  });
});

describe("no answer is never a pass", () => {
  it.each([undefined, null, ""])("refuses %j", (observed) => {
    // Treating "we did not hear back" as "correct" is how a partial run reports clean.
    expect(readBackVerdict(usd(1999), observed).ok).toBe(false);
  });

  it("refuses a value that is not a number", () => {
    expect(readBackVerdict(usd(1999), "not-a-price").ok).toBe(false);
  });

  it("refuses when there was no intended price to compare against", () => {
    expect(readBackVerdict(undefined, "19.99").ok).toBe(false);
  });
});

describe("currency precision", () => {
  it("handles a zero-decimal currency", () => {
    // ¥2,921 is 2921 minor units, not 292100. Getting the scale wrong here fails every
    // row in Japan, or passes every one of them regardless of what was stored.
    expect(readBackVerdict(jpy(2921), "2921").ok).toBe(true);
    expect(readBackVerdict(jpy(2921), "2920").ok).toBe(false);
  });

  it("handles a three-decimal currency", () => {
    expect(readBackVerdict(kwd(19_500), "19.500").ok).toBe(true);
    expect(readBackVerdict(kwd(19_500), "19.501").ok).toBe(false);
  });

  it("parses to the intended currency's scale", () => {
    expect(parseObserved("19.99", usd(0))).toEqual(usd(1999));
    expect(parseObserved("2921", jpy(0))).toEqual(jpy(2921));
    expect(parseObserved("19.500", kwd(0))).toEqual(kwd(19_500));
  });

  it("does not lose a minor unit to floating point", () => {
    // 0.1 + 0.2 arithmetic on prices is the failure mode rule 7 exists to prevent.
    for (const cents of [1, 7, 29, 35_17, 99_99, 1_234_56]) {
      const text = (cents / 100).toFixed(2);
      expect(parseObserved(text, usd(0)), text).toEqual(usd(cents));
    }
  });
});
