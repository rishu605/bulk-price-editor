/**
 * The sentence a merchant reads after pressing Re-sync catalogue.
 *
 * It was built with raw interpolation, so live on `dartmode-labs` it read "Synced 3669
 * variants across 1037 products. Captured 0 baselines, 3672 already current." — two
 * inches above a tile reading "3,669". Same number, same screen, two spellings; and the
 * 3,672 is not variants at all.
 */

import { describe, expect, it } from "vitest";

import { syncMessage } from "./sync-message";

const outcome = (over: Partial<Parameters<typeof syncMessage>[0]> = {}) =>
  syncMessage({
    variants: 3_669,
    products: 1_037,
    captured: 0,
    alreadyCurrent: 3_672,
    priceLists: 5,
    relative: 5,
    entries: 3,
    ...over,
  });

describe("the numbers", () => {
  it("groups every one of them", () => {
    const message = outcome();

    expect(message).toContain("3,669 variants");
    expect(message).toContain("1,037 products");
    expect(message).toContain("3,672 price surfaces");
  });

  it("does not leave an ungrouped four-digit number anywhere", () => {
    // The failure exactly: a bare run of four or more digits.
    expect(outcome()).not.toMatch(/(?<![\d,])\d{4,}/);
  });

  it("names what the second number counts, so it is not read as variants", () => {
    // "Variants 3,669" is a tile on the same screen. 3,672 of something unnamed beside
    // it invites an arithmetic that does not work — they count different things.
    expect(outcome()).toContain("price surfaces already had one");
  });
});

describe("the words", () => {
  it("says variant rather than variants when there is one", () => {
    expect(outcome({ variants: 1, products: 1 })).toContain("Synced 1 variant across 1 product.");
  });

  it("says baseline rather than baselines when there is one", () => {
    expect(outcome({ captured: 1, alreadyCurrent: 0 })).toContain("Captured 1 baseline.");
  });

  it("keeps the singular price list", () => {
    expect(outcome({ priceLists: 1, relative: 0, entries: 0 })).toContain(
      "Mirrored 1 price list.",
    );
  });
});

describe("what it leaves out", () => {
  it("says nothing about markets on a shop that has none", () => {
    const message = outcome({ priceLists: 0, relative: 0, entries: 0 });

    expect(message).not.toContain("Mirrored");
    expect(message.endsWith("already had one.")).toBe(true);
  });

  it("says nothing about surfaces that already had a baseline when none did", () => {
    expect(outcome({ captured: 12, alreadyCurrent: 0 })).toContain("Captured 12 baselines.");
  });
});
