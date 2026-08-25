/**
 * Choosing rounding per currency.
 *
 * The case that matters is a campaign priced into several markets at once. One shared
 * profile makes at least one market's prices look wrong to the people shopping in it,
 * and looking local is the entire reason to price per market.
 */

import { describe, expect, it } from "vitest";

import { applyRounding } from "./rounding";
import { money } from "./money";
import {
  NO_ROUNDING_POLICY,
  defaultPolicyFor,
  parseRoundingPolicy,
  policyOf,
  profileFor,
  profileNameFor,
  resolvePolicy,
  ROUNDING_PROFILES,
} from "./rounding-policy";

describe("picking a profile for a currency", () => {
  it("uses the override when the currency has one", () => {
    const policy = resolvePolicy({ default: "charm99", byCurrency: { EUR: "charm95" } });

    // 19.70 rather than 19.47: the latter is genuinely nearer 18.99 than 19.99, so it
    // would have tested the direction of "nearest" rather than which profile applied.
    expect(applyRounding(money(1970, "USD"), profileFor(policy, "USD")).amount).toBe(1999);
    expect(applyRounding(money(1970, "EUR"), profileFor(policy, "EUR")).amount).toBe(1995);
  });

  it("matches the currency case-insensitively", () => {
    // Shopify returns upper-case codes; a hand-written import may not. A policy that
    // silently failed to match would fall through to the default and round a market
    // the merchant had explicitly configured.
    const policy = resolvePolicy({ default: "none", byCurrency: { GBP: "charm99" } });

    expect(applyRounding(money(1970, "gbp"), profileFor(policy, "gbp")).amount).toBe(1999);
  });

  it("falls back to the default for a currency with no override", () => {
    const policy = resolvePolicy({ default: "charm99", byCurrency: { EUR: "charm95" } });

    expect(profileFor(policy, "GBP")).toEqual(ROUNDING_PROFILES.charm99);
  });
});

describe("zero-decimal currencies (E9)", () => {
  it("does not inherit a charm ending into yen", () => {
    // There is no sub-yen space for a .99 ending. Inheriting it would show the
    // merchant "prices ending .99" on the campaign and produce yen prices that do not,
    // which is worse than either honest answer.
    const policy = resolvePolicy({ default: "charm99", byCurrency: {} });

    expect(profileFor(policy, "JPY")).toEqual(ROUNDING_PROFILES.nearest10);
  });

  it("says the same thing in the interface that it does to the prices", () => {
    expect(profileNameFor({ default: "charm99", byCurrency: {} }, "JPY")).toBe("nearest10");
    expect(profileNameFor({ default: "charm99", byCurrency: {} }, "USD")).toBe("charm99");
  });

  it("never produces a fractional yen", () => {
    const policy = resolvePolicy({ default: "charm99", byCurrency: {} });

    for (const amount of [1, 7, 1947, 100_003]) {
      const rounded = applyRounding(money(amount, "JPY"), profileFor(policy, "JPY"));
      expect(Number.isInteger(rounded.amount)).toBe(true);
    }
  });

  it("keeps a whole-amount profile, which yen can express", () => {
    // "No cents" is meaningful in a currency that has no cents: it is the identity,
    // not a degradation. Rewriting it to nearest-10 would round prices the merchant
    // asked to leave alone.
    const policy = resolvePolicy({ default: "whole", byCurrency: {} });

    expect(profileFor(policy, "JPY")).toEqual(ROUNDING_PROFILES.whole);
  });

  it("seeds a store default that suits each currency", () => {
    const policy = defaultPolicyFor(["USD", "JPY", "EUR"]);

    expect(policy.default).toBe("charm99");
    expect(policy.byCurrency.JPY).toBe("nearest10");
    expect(policy.byCurrency.EUR).toBeUndefined();
  });
});

describe("reading a stored policy", () => {
  it("reads the bare string older campaigns stored", () => {
    // A campaign created before per-currency rounding must keep pricing exactly as it
    // did. A migration that changed what an existing campaign does to live prices is
    // the one migration this product cannot ship.
    expect(parseRoundingPolicy("charm99")).toEqual({ default: "charm99", byCurrency: {} });
  });

  it("reads a campaign that stored nothing as no rounding", () => {
    expect(parseRoundingPolicy(undefined)).toEqual({ default: "none", byCurrency: {} });
    expect(parseRoundingPolicy(null)).toEqual({ default: "none", byCurrency: {} });
  });

  it("drops profile names it does not recognise rather than throwing", () => {
    // A campaign is not worth failing over an unknown name from a future or rolled-back
    // release. Falling back to no rounding leaves prices exactly as calculated, which
    // is the one outcome that cannot surprise anybody.
    expect(parseRoundingPolicy({ default: "bananas", byCurrency: { EUR: "charm95", JPY: "nope" } }))
      .toEqual({ default: "none", byCurrency: { EUR: "charm95" } });
  });

  it("normalises currency codes on the way in", () => {
    expect(parseRoundingPolicy({ default: "none", byCurrency: { eur: "charm95" } }).byCurrency)
      .toEqual({ EUR: "charm95" });
  });
});

describe("the no-rounding policy", () => {
  it("leaves a price exactly as calculated", () => {
    expect(applyRounding(money(1947, "USD"), profileFor(NO_ROUNDING_POLICY, "USD")).amount)
      .toBe(1947);
  });

  it("wraps a single profile for every currency", () => {
    const policy = policyOf(ROUNDING_PROFILES.charm95);

    expect(profileFor(policy, "USD")).toEqual(ROUNDING_PROFILES.charm95);
    expect(profileFor(policy, "GBP")).toEqual(ROUNDING_PROFILES.charm95);
  });
});
