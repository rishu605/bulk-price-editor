/**
 * Detecting market changes that happen while campaigns are running (E15).
 *
 * The tests are as much about what does *not* need the merchant as what does. An app
 * that asks a question every time Shopify reports a rename trains its user to dismiss
 * the question that matters.
 */

import { describe, expect, it } from "vitest";

import {
  describeChange,
  diffTopology,
  needsDecision,
  type MarketSnapshot,
} from "./topology";

const list = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  priceListGid: "gid://shopify/PriceList/eu",
  name: "Europe",
  currency: "EUR",
  adjustmentBps: -1000,
  surfaceKind: "MARKET",
  ...over,
});

describe("diffing market topology", () => {
  it("reports a market that disappeared", () => {
    const changes = diffTopology([list()], []);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "removed", name: "Europe" });
  });

  it("reports a market that appeared", () => {
    const changes = diffTopology([], [list()]);

    expect(changes[0]).toMatchObject({ kind: "added", name: "Europe" });
  });

  it("reports a currency change with both currencies", () => {
    // Shopify permits this and it silently reinterprets every fixed price on the list:
    // 2000 minor units was €20.00 and is now ¥2,000.
    const changes = diffTopology([list()], [list({ currency: "JPY" })]);

    expect(changes[0]).toMatchObject({
      kind: "currency-changed",
      before: { currency: "EUR" },
      after: { currency: "JPY" },
    });
  });

  it("puts the destructive news first", () => {
    const changes = diffTopology(
      [list(), list({ priceListGid: "gone", name: "Old" })],
      [list({ name: "Europe (EU)" }), list({ priceListGid: "new", name: "New" })],
    );

    // A merchant scanning this list needs "a market is gone" above "a market was
    // renamed", whatever order Shopify happened to return them in.
    expect(changes.map((change) => change.kind)).toEqual(["removed", "added", "renamed"]);
  });

  it("reports nothing when nothing changed", () => {
    expect(diffTopology([list()], [list()])).toEqual([]);
  });

  it("separates a currency change from the rename that came with it", () => {
    // They usually arrive together, and rolling them into one change would let the
    // benign half decide whether the merchant hears about the serious half.
    const changes = diffTopology([list()], [list({ currency: "JPY", name: "Japan" })]);

    expect(changes.map((change) => change.kind)).toEqual(["currency-changed", "renamed"]);
  });

  it("notices a market's standing percentage moving", () => {
    const changes = diffTopology([list()], [list({ adjustmentBps: -1500 })]);

    expect(changes[0]).toMatchObject({
      kind: "adjustment-changed",
      before: { adjustmentBps: -1000 },
      after: { adjustmentBps: -1500 },
    });
  });

  it("treats a list gaining its first percentage as a change, not as nothing", () => {
    // null and 0 are different states: one is a list with no parent adjustment at all,
    // the other is one pinned at zero. A diff that conflated them would miss a market
    // switching from fixed prices to derived ones.
    const changes = diffTopology([list({ adjustmentBps: null })], [list({ adjustmentBps: 0 })]);

    expect(changes[0]).toMatchObject({ kind: "adjustment-changed" });
  });
});

describe("deciding what to ask the merchant about", () => {
  it("asks about a market that vanished", () => {
    expect(needsDecision({ kind: "removed", priceListGid: "x", name: "Europe" })).toBe(true);
  });

  it("asks about a currency change", () => {
    expect(needsDecision({ kind: "currency-changed", priceListGid: "x", name: "Europe" }))
      .toBe(true);
  });

  it("offers a new market rather than joining campaigns to it silently", () => {
    // An existing campaign was approved against the markets that existed when it was
    // approved. Auto-enrolling products is safe because the rule is what the merchant
    // chose; auto-enrolling a whole market is a decision about which countries see a
    // sale.
    expect(needsDecision({ kind: "added", priceListGid: "x", name: "Japan" })).toBe(true);
  });

  it("does not ask about a rename", () => {
    // Asking every time trains a merchant to dismiss the question that matters.
    expect(needsDecision({ kind: "renamed", priceListGid: "x", name: "Europe" })).toBe(false);
  });

  it("does not ask about the market's own percentage moving", () => {
    // Campaigns compute from the market's own prices, so the next run simply follows
    // the new percentage. There is nothing for the merchant to decide.
    expect(needsDecision({ kind: "adjustment-changed", priceListGid: "x", name: "Europe" }))
      .toBe(false);
  });
});

describe("telling the merchant what happened", () => {
  it("names the market, the cause and what to do next", () => {
    const message = describeChange(
      { kind: "removed", priceListGid: "x", name: "Europe" },
      ["Summer sale"],
    );

    expect(message).toContain("Europe");
    expect(message).toContain("Summer sale");
    expect(message).toContain("remove it from them");
  });

  it("summarises rather than listing every campaign", () => {
    const message = describeChange(
      { kind: "removed", priceListGid: "x", name: "Europe" },
      ["A", "B", "C", "D", "E"],
    );

    expect(message).toContain("and 2 more");
  });

  it("says nothing about campaigns when none target the market", () => {
    const message = describeChange({ kind: "added", priceListGid: "x", name: "Japan" }, []);

    expect(message).not.toContain("targeted by");
  });
});
