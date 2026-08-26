/**
 * The sentence a merchant reads when a market answers in the wrong currency.
 *
 * The detector that used to live beside this is gone (#257). It inferred the problem from
 * arithmetic on a theory that turned out to be wrong, and market prices now come from
 * `contextualPricing`, where the currency is stated rather than deduced.
 *
 * What survives is the wording, because that half was always the useful one: a price in
 * the wrong currency is the only kind of wrong price that looks entirely ordinary — €797.36
 * where ¥797.36 would be absurd on sight — so the message has to say which currency turned
 * up, not merely that something was off.
 */

import { describe, expect, it } from "vitest";

import { unconvertedMessage } from "./conversion-check";

describe("unconvertedMessage", () => {
  it("names the market, the currency that arrived, and the next action", () => {
    const message = unconvertedMessage("Japan", "JPY", "USD");

    expect(message).toContain("Japan");
    expect(message).toContain("JPY");
    // Without this, "wrong currency" and "wrong by an exchange rate" are the same
    // unhelpful sentence to somebody trying to work out what happened.
    expect(message).toContain("USD");
    expect(message).toMatch(/Settings → Markets/);
    // And says what still happened, so a merchant is not left wondering whether the whole
    // campaign died.
    expect(message).toMatch(/other surface/i);
  });

  it("still reads sensibly when the currency is unknown", () => {
    const message = unconvertedMessage("Europe", "EUR");

    expect(message).toContain("Europe");
    expect(message).toContain("EUR");
    expect(message).not.toContain("undefined");
  });
});
