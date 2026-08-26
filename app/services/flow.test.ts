/**
 * What a Flow trigger is allowed to carry.
 *
 * A payload passes through Flow and into whatever the merchant connected next — a Slack
 * channel, a spreadsheet, another app's API — and out of anywhere we can reason about.
 * The rule is the same as telemetry's, for a stronger reason.
 */

import { describe, expect, it } from "vitest";

import { containsPrice } from "./flow.server";

describe("refusing to send a price", () => {
  it("passes a payload of ids, names and counts", () => {
    expect(
      containsPrice({
        "campaign id": "c1",
        "campaign name": "Summer sale",
        "products affected": 412,
        outcome: "clean",
      }),
    ).toBe(false);
  });

  it("catches a field named like money", () => {
    expect(containsPrice({ "campaign id": "c1", price: 1999 })).toBe(true);
    expect(containsPrice({ "campaign id": "c1", compareAtPrice: 2999 })).toBe(true);
    expect(containsPrice({ "campaign id": "c1", unit_cost: 500 })).toBe(true);
  });

  it("catches a money-shaped value under an innocent name", () => {
    // The realistic leak: somebody adds a field called `threshold` that happens to hold
    // "19.99". Names are the obvious check and values are the one that catches it.
    expect(containsPrice({ "campaign id": "c1", threshold: "19.99" })).toBe(true);
    expect(containsPrice({ "campaign id": "c1", note: "£15.50" })).toBe(true);
    // With a thousands separator, which is the shape a price takes once it has been
    // formatted for display. The first version of this check missed it, and the test
    // asserting it was fine was itself the bug.
    expect(containsPrice({ "campaign id": "c1", note: "$1,299.00" })).toBe(true);
    expect(containsPrice({ "campaign id": "c1", note: "1 299,00" })).toBe(true);
  });

  it("catches a bigint, which is how minor units travel here", () => {
    expect(containsPrice({ "campaign id": "c1", something: BigInt(1999) })).toBe(true);
  });

  it("looks inside nested objects", () => {
    expect(containsPrice({ "campaign id": "c1", detail: { price: 1999 } })).toBe(true);
  });

  it("does not mistake a count or an id for a price", () => {
    // 412 products and a gid ending in digits must not trip it, or every trigger would
    // be refused and the feature would silently not exist.
    expect(
      containsPrice({
        "campaign id": "gid://shopify/Campaign/12345",
        "products affected": 412,
        "products reverted": 0,
      }),
    ).toBe(false);
  });
});
