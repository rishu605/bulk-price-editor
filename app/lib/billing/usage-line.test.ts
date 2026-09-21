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
    synced: true,
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
    synced: true,
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
      synced: true,
    });

    expect(line.headline).toContain("no variant limit");
    expect(line.detail).toContain("can cover all of it");
    expect(line.attention).toBe(false);
  });
});

describe("a shop that has not synced yet", () => {
  // The first screen after installing. `catalogueVariants` is 0 because nobody has
  // looked, not because the shop is empty — and the sentence used to read it as a fact
  // about the store. Live on `anchor-perf`, which has 102,132 variants in Shopify, it
  // said "Your whole catalogue is 0 variants, so no campaign can reach the limit."
  const line = usageLine({
    planName: "Free",
    variantLimit: 500,
    catalogueVariants: 0,
    couldExceed: false,
    synced: false,
  });

  it("still says what the plan covers", () => {
    expect(line.headline).toBe("Free · campaigns up to 500 variants");
  });

  it("claims nothing about a catalogue it has not read", () => {
    expect(line.detail).not.toContain("0 variants");
    expect(line.detail).not.toContain("no campaign can reach the limit");
  });

  it("says what would make the sentence complete", () => {
    expect(line.detail).toContain("Sync your catalogue");
  });

  it("draws no attention, because nothing is wrong yet", () => {
    expect(line.attention).toBe(false);
  });

  it("does not invent a catalogue on an uncapped plan either", () => {
    const uncapped = usageLine({
      planName: "Scale",
      variantLimit: null,
      catalogueVariants: 0,
      couldExceed: false,
      synced: false,
    });

    expect(uncapped.headline).toContain("no variant limit");
    expect(uncapped.detail).not.toContain("0 variants");
    expect(uncapped.detail).toContain("whatever size it turns out to be");
  });
});
