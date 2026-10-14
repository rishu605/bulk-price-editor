/**
 * The rules the ledger draws "Revert this variant" by and the action refuses it by (#764).
 *
 * One module for both, so a button offered by one rule and accepted by another cannot
 * happen. These pin what the rules are; `campaign-ledger-tab.test.tsx` checks the button
 * follows them and `ledger-variant-revert.chaos.ts` checks the action does.
 */

import { describe, expect, it } from "vitest";

import { ALL_STATES } from "../lifecycle/transitions";
import { isVariantGid, offersVariantRevert, VARIANT_REVERT_STATES, wroteThisRow } from "./variant-revert-offer";

describe("which campaigns and runs offer it", () => {
  it("is the three states with prices up and nobody writing them", () => {
    expect([...VARIANT_REVERT_STATES].sort()).toEqual(["ACTIVE", "HELD", "PARTIAL"]);
  });

  it.each(ALL_STATES)("a %s campaign's revert never offers it", (state) => {
    expect(offersVariantRevert(state, "REVERT")).toBe(false);
  });

  it("an apply of a live campaign does, and a missing run does not", () => {
    expect(offersVariantRevert("ACTIVE", "APPLY")).toBe(true);
    expect(offersVariantRevert("ACTIVE", null)).toBe(false);
    expect(offersVariantRevert("ACTIVE", undefined)).toBe(false);
  });
});

describe("which rows were written", () => {
  it.each(["VERIFIED", "CLAMPED", "APPLIED"])("%s was", (status) => {
    expect(wroteThisRow(status)).toBe(true);
  });

  it.each(["PENDING", "WRITING", "FAILED", "SKIPPED", "REVERTED"])("%s was not", (status) => {
    expect(wroteThisRow(status)).toBe(false);
  });
});

describe("what passes for a variant GID", () => {
  it.each(["gid://shopify/ProductVariant/45725717004522", "gid://shopify/ProductVariant/seed-0-1"])("%s does", (gid) => {
    expect(isVariantGid(gid)).toBe(true);
  });

  it.each([
    // What `String(form.get("variantGid"))` made of a missing field.
    ["the string null", "null"],
    ["nothing", null],
    ["empty", ""],
    ["a product", "gid://shopify/Product/1"],
    ["no id", "gid://shopify/ProductVariant/"],
    ["a trailing path", "gid://shopify/ProductVariant/1/2"],
    ["a file", new File([], "x")],
  ])("%s does not", (_label, value) => {
    expect(isVariantGid(value)).toBe(false);
  });
});
