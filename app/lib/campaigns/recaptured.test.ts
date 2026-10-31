/**
 * A baseline recaptured at a running campaign's own sale price (#781).
 *
 * On DartMode Labs a 20% sale took a $100 board to $80, the whole catalogue was recaptured,
 * and the board's baseline became $80. These pin the rule that finds that from the ledger --
 * and the cases that look like it and are not.
 */

import { describe, expect, it } from "vitest";

import { priceBeforeStint, recapturedAtSale, stintOf, type StintRow } from "./recaptured";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 12, minute));
const apply = (before: number, intended: number, minute: number): StintRow => ({
  revert: false,
  before: BigInt(before),
  intended: BigInt(intended),
  at: at(minute),
});
const revert = (before: number, intended: number, minute: number): StintRow => ({ ...apply(before, intended, minute), revert: true });

describe("a campaign's writes on a variant since it last reverted there", () => {
  it("are every write when it never reverted, newest first", () => {
    const rows = [apply(8_000, 6_400, 30), apply(10_000, 8_000, 10)];
    expect(stintOf(rows)).toEqual(rows);
  });

  it("stop at its revert, and are none when the revert is newest", () => {
    const rows = [apply(10_000, 8_000, 40), revert(8_000, 10_000, 20), apply(10_000, 8_000, 10)];
    expect(stintOf(rows)).toEqual([rows[0]]);
    expect(stintOf(rows.slice(1))).toEqual([]);
  });

  it("start from the price the first write found, not the campaign's own earlier price", () => {
    // The compounded apply recorded Before 80.00; the price before the campaign was 100.00.
    expect(priceBeforeStint(stintOf([apply(8_000, 6_400, 30), apply(10_000, 8_000, 10)]))).toBe(10_000n);
    expect(priceBeforeStint([])).toBeNull();
  });
});

describe("a baseline recaptured at the sale price", () => {
  const sale = [apply(10_000, 8_000, 10)];

  it("is the live case: captured after the sale was written, at the sale's price", () => {
    expect(recapturedAtSale(sale, { price: 8_000n, capturedAt: at(20) })).toBe(true);
  });

  it("is still one after a second apply compounded it, at the first sale price", () => {
    const compounded = [apply(8_000, 6_400, 30), ...sale];
    expect(recapturedAtSale(compounded, { price: 8_000n, capturedAt: at(20) })).toBe(true);
  });

  it("is not a baseline at the price from before the campaign, which is the ordinary case", () => {
    expect(recapturedAtSale(sale, { price: 10_000n, capturedAt: at(20) })).toBe(false);
  });

  it("is not a new normal price imported mid-sale, which no write of the campaign's set", () => {
    expect(recapturedAtSale(sale, { price: 12_000n, capturedAt: at(20) })).toBe(false);
  });

  it("is not a baseline captured before the campaign wrote there", () => {
    // A fixed-price sale over a live price someone had moved: the campaign wrote its baseline's own price.
    expect(recapturedAtSale([apply(9_000, 8_000, 10)], { price: 8_000n, capturedAt: at(5) })).toBe(false);
  });

  it("is not one where the campaign is not pricing the variant, or the ledger has no price before it", () => {
    expect(recapturedAtSale([], { price: 8_000n, capturedAt: at(20) })).toBe(false);
    expect(recapturedAtSale([{ ...sale[0]!, before: null }], { price: 8_000n, capturedAt: at(20) })).toBe(false);
  });
});
