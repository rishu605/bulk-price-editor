/**
 * Refusing a market price that was never converted.
 *
 * The euro case is the one that matters. A yen price with decimals is caught anyway,
 * because `parseMoney` will not accept fractional yen — but €797.36 is an ordinary
 * price that happens to be wrong by an exchange rate, and nothing else in the system
 * would ever question it.
 */

import { describe, expect, it } from "vitest";

import { looksUnconverted, unconvertedMessage } from "./conversion-check";

/** The real values the dev store returned, which is what prompted all of this. */
const OBSERVED = { baseMinorUnits: 88_595, adjustmentBps: -1_000, derivedAmount: "797.36" };

describe("looksUnconverted", () => {
  it("catches the euro case, which nothing else would", () => {
    // $885.95 less 10% is $797.36, returned unchanged and labelled EUR.
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "EUR", shopCurrency: "USD" }),
    ).toBe(true);
  });

  it("catches the yen case before the parser blames the currency", () => {
    // Same number, labelled JPY. `parseMoney` would throw here with a message about
    // decimal places, which sends a merchant to look at their prices rather than at
    // their market.
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "JPY", shopCurrency: "USD" }),
    ).toBe(true);

    // And the shape the dev store actually returned for a cheap variant.
    expect(
      looksUnconverted({
        baseMinorUnits: 800,
        adjustmentBps: -1_000,
        derivedAmount: "7.2",
        listCurrency: "JPY",
        shopCurrency: "USD",
      }),
    ).toBe(true);
  });

  it("accepts a properly converted euro price", () => {
    // $885.95 less 10% is $797.36; at roughly 0.92 EUR/USD that is about €733.
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "EUR", shopCurrency: "USD", derivedAmount: "733.57" }),
    ).toBe(false);
  });

  it("accepts a properly converted yen price", () => {
    // The number that made this worth catching: ¥797 versus the ¥119,604 it should be.
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "JPY", shopCurrency: "USD", derivedAmount: "119604" }),
    ).toBe(false);
  });

  it("says nothing about a list in the shop's own currency", () => {
    // A USD list on a USD shop is unconverted by definition and entirely correct.
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "USD", shopCurrency: "USD" }),
    ).toBe(false);
  });

  it("tolerates Shopify rounding its own way by a minor unit", () => {
    // The rule gives 797.355. Shopify may send either neighbour, and both are still
    // unmistakably unconverted.
    for (const amount of ["797.35", "797.36"]) {
      expect(
        looksUnconverted({ ...OBSERVED, listCurrency: "EUR", shopCurrency: "USD", derivedAmount: amount }),
      ).toBe(true);
    }
  });

  it("compares in major units, so a zero-decimal shop currency is not off by a hundred", () => {
    // A JPY shop pricing into USD. ¥10,000 is 10,000 minor units, not 1,000,000 — and a
    // check that assumed two decimals everywhere would compute ¥100 and call a correct
    // conversion unconverted, refusing a market that was working perfectly.
    expect(
      looksUnconverted({
        baseMinorUnits: 10_000,
        adjustmentBps: -1_000,
        derivedAmount: "9000",
        listCurrency: "USD",
        shopCurrency: "JPY",
      }),
    ).toBe(true);

    expect(
      looksUnconverted({
        baseMinorUnits: 10_000,
        adjustmentBps: -1_000,
        derivedAmount: "60.30",
        listCurrency: "USD",
        shopCurrency: "JPY",
      }),
    ).toBe(false);
  });

  it("does not choke on an amount Shopify could not give", () => {
    expect(
      looksUnconverted({ ...OBSERVED, listCurrency: "EUR", shopCurrency: "USD", derivedAmount: "" }),
    ).toBe(false);
  });
});

describe("unconvertedMessage", () => {
  it("names the market, the cause and the next action", () => {
    const message = unconvertedMessage("Japan", "JPY");

    expect(message).toContain("Japan");
    expect(message).toContain("JPY");
    expect(message).toMatch(/Settings → Markets/);
    // And says what still happened, so a merchant is not left wondering whether the
    // whole campaign died.
    expect(message).toMatch(/other surface/i);
  });
});
