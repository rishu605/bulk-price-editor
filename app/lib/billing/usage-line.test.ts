/**
 * The plan meter's tone is the point.
 *
 * D3 says safety features are never paywalled: preview, revert, the ledger and the drift
 * hold are on every tier including free, and the cap is on how much one campaign may
 * cover. A meter that reads like a countdown to being cut off would be describing a
 * product we did not build — on the page a merchant sees most.
 */

import { describe, expect, it } from "vitest";

import { usageLine } from "./usage-line";

describe("a shop that cannot reach its limit", () => {
  const line = usageLine({
    planName: "Growth",
    variantLimit: 10_000,
    catalogueVariants: 1_240,
    couldExceed: false,
  });

  it("leads with what is covered, not with what is used", () => {
    expect(line.headline).toBe("Growth · campaigns up to 10,000 variants");
  });

  it("says the limit is out of reach rather than counting towards it", () => {
    // The difference between "1,240 of 10,000" and this sentence is the difference
    // between a countdown and a fact. Nothing here is consumed.
    expect(line.detail).toContain("no campaign can reach the limit");
  });

  it("draws no attention", () => {
    expect(line.attention).toBe(false);
  });
});

describe("a shop whose catalogue is bigger than the cap", () => {
  const line = usageLine({
    planName: "Starter",
    variantLimit: 500,
    catalogueVariants: 102_132,
    couldExceed: true,
  });

  it("says what would happen, not that something is wrong", () => {
    // A campaign over the cap is refused before it writes anything, which is the same
    // promise the rest of the app makes. Saying so is reassurance, not a threat.
    expect(line.detail).toContain("refused before it writes a price");
  });

  it("names both numbers a merchant would compare", () => {
    expect(line.headline).toContain("500");
    expect(line.detail).toContain("102,132");
  });

  it("is worth drawing attention to, because this one can actually bite", () => {
    expect(line.attention).toBe(true);
  });
});

describe("the tier with no cap", () => {
  it("says so rather than printing a very large number", () => {
    const line = usageLine({
      planName: "Scale",
      variantLimit: null,
      catalogueVariants: 102_132,
      couldExceed: false,
    });

    expect(line.headline).toContain("no variant limit");
    expect(line.detail).toContain("can cover all of it");
    expect(line.attention).toBe(false);
  });
});
