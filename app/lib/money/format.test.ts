import { describe, expect, it } from "vitest";

import { decimalsFor, formatMinorUnits, formatOrDash } from "./format";

describe("formatMinorUnits", () => {
  it("uses the real currency table, not a hardcoded JPY/KRW check", () => {
    // The three service-layer copies this replaced assumed everything except JPY and
    // KRW had two decimals, which is wrong in both directions.
    expect(formatMinorUnits(1999n, "USD")).toBe("19.99");
    expect(formatMinorUnits(1980n, "JPY")).toBe("1980");
    expect(formatMinorUnits(19999n, "KWD")).toBe("19.999"); // three decimals
    expect(formatMinorUnits(1500n, "VND")).toBe("1500"); // zero-decimal, not JPY/KRW
    expect(formatMinorUnits(2500n, "ISK")).toBe("2500");
  });

  it("accepts bigint and number alike", () => {
    expect(formatMinorUnits(500n, "USD")).toBe("5.00");
    expect(formatMinorUnits(500, "USD")).toBe("5.00");
  });

  it("returns null for absent values", () => {
    expect(formatMinorUnits(null, "USD")).toBeNull();
    expect(formatMinorUnits(undefined, "USD")).toBeNull();
  });

  it("handles negatives and sub-unit amounts", () => {
    expect(formatMinorUnits(-450n, "USD")).toBe("-4.50");
    expect(formatMinorUnits(5n, "USD")).toBe("0.05");
    expect(formatMinorUnits(0n, "USD")).toBe("0.00");
  });

  it("falls back rather than throwing on an unknown currency", () => {
    // Display path: a slightly wrong label beats a crashed page. Anything that
    // COMPUTES goes through money(), which does throw.
    expect(formatMinorUnits(1999n, "ZZZ")).toBe("19.99");
  });

  it("formatOrDash renders a dash for absent values", () => {
    expect(formatOrDash(null, "USD")).toBe("—");
    expect(formatOrDash(1999n, "USD")).toBe("19.99");
  });

  it("decimalsFor reports the currency's precision", () => {
    expect(decimalsFor("USD")).toBe(2);
    expect(decimalsFor("JPY")).toBe(0);
    expect(decimalsFor("BHD")).toBe(3);
    expect(decimalsFor("ZZZ")).toBe(2);
  });
});
