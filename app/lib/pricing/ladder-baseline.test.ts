/**
 * A ladder is the one part of a price the database will not check for us.
 *
 * It lives in a JSON column, so every guarantee the schema gives a `BigInt` price has to
 * be re-established in code — and the failure mode is quiet: a wholesale price list where
 * one tier is right and another is silently absent, which a buyer discovers at checkout.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { parseLadder, serialiseLadder, type LadderRung } from "./ladder-baseline";

const gbp = (minor: number) => money(minor, "GBP");
const rung = (minimumQuantity: number, minor: number): LadderRung => ({
  minimumQuantity,
  price: gbp(minor),
});

describe("storing a ladder", () => {
  it("keeps integer minor units, never a formatted price", () => {
    // A ladder that round-trips as "36.00" and comes back a float is rule 7 broken in
    // the least visible place there is.
    expect(serialiseLadder([rung(12, 3600)])).toEqual([{ minimumQuantity: 12, amount: 3600 }]);
  });

  it("sorts by quantity so the stored order never depends on the caller", () => {
    expect(serialiseLadder([rung(48, 3200), rung(1, 4000), rung(12, 3600)])).toEqual([
      { minimumQuantity: 1, amount: 4000 },
      { minimumQuantity: 12, amount: 3600 },
      { minimumQuantity: 48, amount: 3200 },
    ]);
  });

  it("stores no ladder as null rather than an empty array", () => {
    // Two encodings of one state is how a query ends up missing rows.
    expect(serialiseLadder([])).toBeNull();
  });

  it("refuses a fractional amount rather than rounding it", () => {
    // `money()` refuses this first, so the case that reaches here is a Money built as an
    // object literal — which the type allows and which is how a float actually gets in.
    const smuggled = { minimumQuantity: 1, price: { amount: 40.5, currency: "GBP" } };

    expect(() => serialiseLadder([smuggled])).toThrow(/whole number of minor units/);
  });

  it("is the second line of defence, not the first", () => {
    expect(() => gbp(40.5)).toThrow(/integer number of minor units/);
  });
});

describe("reading a ladder back", () => {
  it("round-trips", () => {
    const original = [rung(1, 4000), rung(12, 3600)];

    expect(parseLadder(serialiseLadder(original), "GBP")).toEqual(original);
  });

  it("takes its currency from the baseline, not from the JSON", () => {
    // Storing the currency twice invites the two to disagree.
    const ladder = parseLadder([{ minimumQuantity: 1, amount: 2921 }], "JPY");

    expect(ladder).toEqual([{ minimumQuantity: 1, price: money(2921, "JPY") }]);
  });

  it("sorts what it reads, whatever order the column holds", () => {
    const ladder = parseLadder(
      [
        { minimumQuantity: 48, amount: 3200 },
        { minimumQuantity: 1, amount: 4000 },
      ],
      "GBP",
    );

    expect(ladder!.map((r) => r.minimumQuantity)).toEqual([1, 48]);
  });

  it.each([
    ["absent", null],
    ["undefined", undefined],
    ["empty", []],
    ["not a list", { minimumQuantity: 1, amount: 4000 }],
    ["a string", "1+ at 40.00"],
  ])("treats %s as no ladder", (_name, raw) => {
    expect(parseLadder(raw, "GBP")).toBeNull();
  });

  it.each([
    ["a fractional amount", [{ minimumQuantity: 1, amount: 40.5 }]],
    ["an amount that is a string", [{ minimumQuantity: 1, amount: "4000" }]],
    ["a fractional quantity", [{ minimumQuantity: 1.5, amount: 4000 }]],
    ["a zero quantity", [{ minimumQuantity: 0, amount: 4000 }]],
    ["a missing amount", [{ minimumQuantity: 1 }]],
    ["a null rung", [null]],
  ])("discards the whole ladder for %s", (_name, raw) => {
    // Half a ladder is worse than none: none is visible, half is not.
    expect(parseLadder(raw, "GBP")).toBeNull();
  });

  it("discards a ladder where one good rung sits beside a bad one", () => {
    const raw = [
      { minimumQuantity: 1, amount: 4000 },
      { minimumQuantity: 12, amount: 36.5 },
    ];

    expect(parseLadder(raw, "GBP")).toBeNull();
  });

  it("discards a ladder with two rungs at the same quantity", () => {
    const raw = [
      { minimumQuantity: 12, amount: 3600 },
      { minimumQuantity: 12, amount: 3400 },
    ];

    // Shopify keeps one and there is no way to say which, so neither is the baseline.
    expect(parseLadder(raw, "GBP")).toBeNull();
  });
});
