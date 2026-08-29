import { describe, expect, it } from "vitest";

import { roundingExample, roundingExampleLine } from "./rounding-example";
import { ROUNDING_PROFILES, type RoundingProfileName } from "./rounding-policy";

const NAMES = Object.keys(ROUNDING_PROFILES) as RoundingProfileName[];

describe("a worked example for every option", () => {
  it.each(NAMES)("%s says something", (name) => {
    // Every option a merchant can pick has to explain itself. An option with a blank
    // example is worse than no examples at all: it reads as the one that does nothing.
    expect(roundingExampleLine(name, "USD")).toMatch(/\S/);
  });

  it("gives a different answer for every option that is a different option", () => {
    // The reason the sample price is awkward: on a tidy number several profiles agree,
    // and a merchant comparing them learns nothing.
    //
    // "Nearest 100" is excluded because on a two-decimal currency it is the same
    // function as "Whole amounts" — charm-ending-0 and step-100-minor-units both land on
    // the whole major unit. `roundingChoices` stops offering it here for that reason;
    // asserting the two differ would be asserting a bug.
    const compared = NAMES.filter((name) => name !== "none" && name !== "nearest100");
    const answers = compared.map((name) => roundingExample(name, "USD").after);

    expect(new Set(answers).size).toBe(answers.length);
  });

  it("rounds in minor units, which is what the labels now say", () => {
    // Pinned deliberately, because it is surprising: "Nearest 10" is ten cents, not ten
    // dollars. The label says "Nearest 0.10" for exactly this reason (#489), and the
    // worked example says it again on a real number.
    expect(roundingExample("nearest10", "USD").after).toBe("$2,347.60");
    expect(roundingExample("nearest100", "USD").after).toBe("$2,348.00");
  });

  it("computes the answer rather than quoting one", () => {
    // Through the real profile: a hand-written example would be a second implementation
    // of rounding, free to disagree with the first, in the one place a merchant is being
    // told they can trust it.
    expect(roundingExample("charm99", "USD").after).toBe("$2,347.99");
    expect(roundingExample("charm95", "USD").after).toBe("$2,347.95");
    expect(roundingExample("whole", "USD").after).toBe("$2,348.00");
  });

  it("leaves the price alone when the option says it will", () => {
    const example = roundingExample("none", "USD");

    expect(example.after).toBe(example.before);
  });
});

describe("a currency with no sub-unit", () => {
  it("refuses to demonstrate a charm ending in yen", () => {
    // Not a bad choice — there is nothing it could mean. Showing "¥2,347.99" would be
    // teaching a merchant something false about their own store.
    const example = roundingExample("charm99", "JPY");

    expect(example.after).toBeNull();
    expect(example.unavailable).toContain("no decimal places");
  });

  it("says whole amounts are already whole", () => {
    expect(roundingExample("whole", "JPY").unavailable).toContain("already whole");
  });

  it("still demonstrates the options that do mean something", () => {
    // Nearest 10 and nearest 100 are about the major unit, so they work everywhere.
    expect(roundingExample("nearest100", "JPY").after).not.toBeNull();
    expect(roundingExample("nearest100", "JPY").unavailable).toBeNull();
  });

  it("never shows a decimal point for a zero-decimal currency", () => {
    // The acceptance criterion, checked across every option rather than the one that
    // happened to be wrong.
    for (const name of NAMES) {
      expect(roundingExampleLine(name, "JPY")).not.toMatch(/\d\.\d/);
    }
  });
});
