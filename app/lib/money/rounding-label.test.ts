/**
 * A merchant reading an option's name alone cannot be wrong about what it does.
 *
 * The labels were currency-independent and two of them lied because of it. A step is in
 * **minor units** — `nearest10` is `{ step: 10 }` — so "Nearest 10" on $2,347.62 produced
 * $2,347.60 rather than the $2,350 the name promises. In yen, where the minor unit *is*
 * the yen, the same label was exactly right, which is why it survived review.
 *
 * The fix is a labelling one on purpose. `ROUNDING_PROFILES` is untouched, so no campaign
 * prices differently on its next run than it did on its last — the acceptance criterion
 * that ruled out the alternative of changing the steps to match the words.
 */

import { describe, expect, it } from "vitest";

import { ROUNDING_PROFILES, roundingLabel, type RoundingProfileName } from "./rounding-policy";
import { roundingChoices } from "./rounding-example";

const NAMES = Object.keys(ROUNDING_PROFILES) as RoundingProfileName[];

describe("a step, in the currency's own units", () => {
  it("says ten cents in dollars, because that is what it does", () => {
    expect(roundingLabel("nearest10", "USD")).toBe("Nearest 0.10");
    expect(roundingLabel("nearest100", "USD")).toBe("Nearest 1.00");
  });

  it("says ten yen in yen, because that is what it does there", () => {
    // The same profile, honestly labelled two ways. In a currency whose minor unit is the
    // major unit, "Nearest 10" was never wrong — which is exactly why one label could not
    // serve both.
    expect(roundingLabel("nearest10", "JPY")).toBe("Nearest 10");
    expect(roundingLabel("nearest100", "JPY")).toBe("Nearest 100");
  });

  it("leaves the labels that do not depend on a currency alone", () => {
    expect(roundingLabel("charm99", "USD")).toBe("Prices ending .99");
    expect(roundingLabel("none", "JPY")).toBe("Leave prices exactly as calculated");
  });
});

describe("what the arithmetic actually does is unchanged", () => {
  it("still steps minor units", () => {
    // The half that must not have moved. If this changes, every campaign on these
    // profiles prices differently on its next run.
    expect(ROUNDING_PROFILES.nearest10).toEqual({ mode: "step", step: 10, direction: "nearest" });
    expect(ROUNDING_PROFILES.nearest100).toEqual({ mode: "step", step: 100, direction: "nearest" });
  });

  it("keeps every profile name a merchant's campaign might already store", () => {
    // Dropping an option from a picker must not drop it from the app: a campaign holding
    // `nearest100` has to keep resolving.
    expect(NAMES).toContain("nearest100");
    expect(NAMES).toContain("whole");
  });
});

describe("no two options are the same thing under different names", () => {
  it("offers whole amounts or the whole-unit step, not both", () => {
    // On a two-decimal currency `whole` (charm ending 0) and `nearest100` land on the
    // same number for every input — one function reached by two names. Offering both asks
    // a merchant to choose between identical things.
    const usd = roundingChoices("USD").map((choice) => choice.value);

    expect(usd).toContain("whole");
    expect(usd).not.toContain("nearest100");
  });

  it("gives every offered option a different answer", () => {
    // The general form of the same rule, and the reason the sample price is awkward.
    const answers = roundingChoices("USD")
      .filter((choice) => choice.value !== "none")
      .map((choice) => choice.example);

    expect(new Set(answers).size).toBe(answers.length);
  });
});

describe("options that mean nothing in a currency are not offered in it", () => {
  const jpy = roundingChoices("JPY").map((choice) => choice.value);

  it("drops the charm endings, which need a sub-unit", () => {
    expect(jpy).not.toContain("charm99");
    expect(jpy).not.toContain("charm95");
  });

  it("drops whole amounts, which yen already is", () => {
    expect(jpy).not.toContain("whole");
  });

  it("keeps the two steps, which are the ones that do something there", () => {
    // And here they keep both, because ¥10 and ¥100 are genuinely different.
    expect(jpy).toContain("nearest10");
    expect(jpy).toContain("nearest100");
  });

  it("never shows a decimal to a currency that has none", () => {
    for (const choice of roundingChoices("JPY")) {
      expect(`${choice.label} ${choice.example}`).not.toMatch(/\d\.\d/);
    }
  });
});
