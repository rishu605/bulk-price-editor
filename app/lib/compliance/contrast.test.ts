/**
 * The contrast maths, checked against values anybody can verify by hand.
 *
 * A ratio function that is subtly wrong would pass every colour pair and prove nothing,
 * which is a worse outcome than not having one.
 */

import { describe, expect, it } from "vitest";

import { contrastRatio, luminance, parseHex, AA_NORMAL } from "./contrast";

describe("the arithmetic", () => {
  it("gives 21 for black on white, the maximum possible", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("gives 1 for a colour against itself", () => {
    expect(contrastRatio("#1a1a1a", "#1a1a1a")).toBeCloseTo(1, 5);
  });

  it("does not care which colour is the text", () => {
    // A version that assumed an order would be wrong half the time.
    expect(contrastRatio("#005bd3", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#005bd3"),
      10,
    );
  });

  it("puts the AA boundary exactly where the published tables put it", () => {
    // #767676 on white is the canonical "just passes AA" grey, at 4.54. One shade
    // lighter drops under 4.5. A ratio function that is a few percent out would still
    // look plausible and would move this boundary, so it is pinned to the hex.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(AA_NORMAL);
  });

  it("applies the sRGB transfer function rather than a linear ramp", () => {
    // Mid grey is nowhere near half the luminance of white; a linear version would say
    // 0.5 and every ratio computed from it would be wrong.
    expect(luminance(parseHex("#808080"))).toBeCloseTo(0.2158, 3);
  });
});

describe("reading a colour", () => {
  it("accepts both hex forms", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it.each(["#ff", "#gggggg", "rgb(0,0,0)", ""])("refuses %j", (value) => {
    expect(() => parseHex(value)).toThrow(/Not a hex colour/);
  });
});
