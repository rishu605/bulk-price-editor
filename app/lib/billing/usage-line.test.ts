/**
 * The plan meter's tone is the point.
 *
 * D3 says safety features are never paywalled: preview, revert, the ledger and the drift
 * hold are on every tier including free, and the cap is on how much one campaign may
 * cover. A meter that reads like a countdown to being cut off would be describing a
 * product we did not build — on the page a merchant sees most.
 */

import { describe, expect, it } from "vitest";

import { giftCardNote, usageLine } from "./usage-line";

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

describe("a development store", () => {
  it("says it is one, rather than naming the tier it is treated as (#860)", () => {
    const line = usageLine({ planName: "Wholesale", variantLimit: null, catalogueVariants: 3_688, couldExceed: false, synced: true, exempt: true });
    expect(line.headline).toBe("Development store · every feature included");
    expect(line.headline).not.toContain("Wholesale");
    expect(line.detail).toMatch(/test charge/);
  });
});

describe("gift cards (#1075)", () => {
  // The count is what a campaign can cover, and no campaign prices a gift card. Live on
  // `dartmode-labs` the meter said 3,669 and a whole-catalogue campaign covered 3,665; the
  // four were gift cards, and nothing on the page said where they went.
  it.each([
    ["no cap", null, false, "Your catalogue is 3,665 variants. A campaign can cover all of it."],
    ["a cap out of reach", 10_000, false, "Your whole catalogue is 3,665 variants, so no campaign can reach the limit."],
    ["a cap within reach", 500, true, "Your catalogue is 3,665 variants, so a campaign covering all of it would need a larger plan."],
  ])("says they are not counted, under %s", (_case, variantLimit, couldExceed, lead) => {
    const line = usageLine({ planName: "Growth", variantLimit, catalogueVariants: 3_665, giftCards: 4, couldExceed, synced: true });
    expect(line.detail.startsWith(lead), line.detail).toBe(true);
    expect(line.detail).toMatch(/ 4 gift cards are not counted: no campaign prices a gift card\.$/);
  });

  it("says nothing of gift cards in a shop with none", () => {
    const line = usageLine({ planName: "Growth", variantLimit: 10_000, catalogueVariants: 1_240, giftCards: 0, couldExceed: false, synced: true });
    expect(line.detail).toBe("Your whole catalogue is 1,240 variants, so no campaign can reach the limit.");
  });

  it("counts one in the singular, and groups a large number", () => {
    expect(giftCardNote(1)).toBe("1 gift card is not counted: no campaign prices a gift card.");
    expect(giftCardNote(1_204)).toBe("1,204 gift cards are not counted: no campaign prices a gift card.");
    expect(giftCardNote(0)).toBe("");
  });
});
