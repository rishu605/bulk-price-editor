/**
 * Money is entered with a money field, never a generic number field.
 *
 * Rule 7 says money is integer minor units with no floats near a price. The server side
 * of that was fixed in #343 — the rule parser takes the currency and uses
 * `10 ** decimalsFor(currency)` rather than a literal 100. This is the other half: a
 * generic number input does not know how many decimal places a currency has, or what a
 * merchant's locale uses as a separator, so it is where a ¥1,000 floor acquires decimals
 * yen does not have.
 *
 * The check reads the routes rather than a list, so a price input added next month is
 * covered without anyone remembering this file exists.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const ROUTES = join(process.cwd(), "app", "routes");
const COMPONENTS = join(process.cwd(), "app", "components");

function sources(): Array<{ name: string; text: string }> {
  const read = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
      .map((e) => ({ name: e.name, text: sourceOf(dir, e.name) }));

  return [...read(ROUTES), ...read(COMPONENTS)];
}

/** A field whose label names a currency, or whose name says it is a price. */
const MONEY_FIELD = /<s-(number|text)-field[^>]*?(?:name="(?:minPrice|price|amount)"|label=\{?`?[^>]*\((?:USD|\$\{currency\})\))/s;

describe("price inputs", () => {
  it("finds files to check, so this cannot pass by checking nothing", () => {
    expect(sources().length).toBeGreaterThan(20);
  });

  it("never enter money through a plain number or text field", () => {
    const offenders = sources()
      .filter(({ text }) => MONEY_FIELD.test(text))
      .map(({ name }) => name);

    expect(
      offenders,
      "these take a currency amount through a generic field — use s-money-field, which " +
        "knows the currency's decimal places and the merchant's separator",
    ).toEqual([]);
  });

  it("uses a money field where a price is entered", () => {
    const withMoney = sources().filter(({ text }) => text.includes("<s-money-field"));

    expect(
      withMoney.map((f) => f.name).sort(),
      "the absolute price floor and the campaign rule amount are both money",
    ).toEqual(["RuleValueField.tsx", "app.settings._index.tsx"]);
  });
});

describe("the rule amount changes with the rule", () => {
  const field = sourceOf(COMPONENTS, "RuleValueField.tsx");

  it("is a percentage for a percent rule and money for a fixed one", () => {
    // One input served both as a generic number field, so "-20" meant 20% off under one
    // rule and £20 off under another, with nothing on screen to say which.
    expect(field).toContain('kind === "fixed-change" || kind === "set-exact"');
    expect(field).toContain("<s-money-field");
    expect(field).toContain("<s-number-field");
  });

  it("stops calling it Value, which is what let the two meanings share a field", () => {
    expect(field).not.toMatch(/label="Value"/);
    expect(field).toContain('label="Percentage"');
  });

  it("names the currency when it is asking for money", () => {
    expect(field).toMatch(/\$\{currency\}/);
  });
});
