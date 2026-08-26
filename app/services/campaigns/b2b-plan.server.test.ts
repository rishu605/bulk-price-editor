/**
 * Planning wholesale ladders for a catalogue.
 *
 * The assertions are about what a merchant is told. A wholesale price is usually
 * something a buyer was quoted, so a product silently dropped from a run is worse here
 * than on any other surface.
 */

import { describe, expect, it } from "vitest";

import { money } from "../../lib/money/money";
import { parseSurfaces } from "./market-surfaces.server";
import { planQuantityBreaks, type B2BVariantInput } from "./b2b-plan.server";
import type { QuantityTier, WholesaleGuardrail } from "../../lib/pricing/quantity-breaks";

const gbp = (minor: number) => money(minor, "GBP");

const LADDER: QuantityTier[] = [
  { minimumQuantity: 1, discountBps: 0 },
  { minimumQuantity: 12, discountBps: 1000 },
];

const permissive: WholesaleGuardrail = { minMarginPercent: 0, missingCost: "allow" };

const variant = (n: number, over: Partial<B2BVariantInput> = {}): B2BVariantInput => ({
  variantGid: `gid://shopify/ProductVariant/${n}`,
  title: `Product ${n}`,
  baseline: gbp(4000),
  ...over,
});

describe("planning a catalogue", () => {
  it("produces a ladder per variant", () => {
    const plan = planQuantityBreaks([variant(1), variant(2)], LADDER, permissive);

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]!.breaks.map((b) => b.price.amount)).toEqual([4000, 3600]);
    expect(plan.refused).toHaveLength(0);
  });

  it("does nothing when the campaign has no tiers at all", () => {
    // Absent tiers means "this is not a tiered campaign", which every campaign written
    // before ladders existed meant and must keep meaning.
    const plan = planQuantityBreaks([variant(1)], undefined, permissive);

    expect(plan.rows).toHaveLength(0);
    expect(plan.messages).toHaveLength(0);
  });

  it("reports a ladder configured with no rungs rather than doing nothing quietly", () => {
    const plan = planQuantityBreaks([variant(1)], [], permissive);

    expect(plan.rows).toHaveLength(0);
    expect(plan.messages.join(" ")).toMatch(/no quantity tiers/i);
  });
});

describe("what the merchant is told", () => {
  const strict: WholesaleGuardrail = { minMarginPercent: 20, missingCost: "refuse" };

  it("names how many products are refused, and why, out of how many", () => {
    const plan = planQuantityBreaks([variant(1), variant(2), variant(3, { cost: gbp(1000) })], LADDER, strict);

    expect(plan.rows).toHaveLength(1);
    expect(plan.refused).toHaveLength(2);
    expect(plan.messages[0]).toMatch(/^2 of 3 products will not be given quantity breaks\./);
    expect(plan.messages[0]).toMatch(/no cost is recorded/i);
  });

  it("groups refusals by reason instead of one line per product", () => {
    // Forty products failing for the same reason is one thing to fix, not forty.
    const many = Array.from({ length: 40 }, (_, i) => variant(i));
    const plan = planQuantityBreaks(many, LADDER, strict);

    expect(plan.refused).toHaveLength(40);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toContain("40 of 40");
  });

  it("says when the floor moved a tier, because it may have been quoted", () => {
    const plan = planQuantityBreaks(
      [variant(1, { cost: gbp(3800) })],
      LADDER,
      { minMarginPercent: 10, missingCost: "allow" },
    );

    // Floor is 3800 / 0.9 = 4223 (rounded up), above both rungs.
    expect(plan.rows).toHaveLength(1);
    expect(plan.clamped.length).toBeGreaterThan(0);
    expect(plan.messages.join(" ")).toMatch(/wholesale floor raised/i);
    expect(plan.messages.join(" ")).toMatch(/quoted to a buyer/i);
  });

  it("says nothing when there is nothing to say", () => {
    expect(planQuantityBreaks([variant(1)], LADDER, permissive).messages).toEqual([]);
  });
});

describe("reading tiers off a campaign row", () => {
  it("keeps a well-formed ladder", () => {
    const surfaces = parseSurfaces({ base: true, priceLists: ["gid://PriceList/1"], quantityTiers: LADDER });

    expect(surfaces.quantityTiers).toEqual(LADDER);
  });

  it("treats an absent ladder as absent, not empty", () => {
    // The difference decides whether the planner does nothing or complains.
    expect(parseSurfaces({ base: true }).quantityTiers).toBeUndefined();
  });

  it("keeps an empty ladder as empty, so the planner can complain about it", () => {
    expect(parseSurfaces({ quantityTiers: [] }).quantityTiers).toEqual([]);
  });

  it.each([
    [{ quantityTiers: "12+" }, undefined],
    [{ quantityTiers: [{ minimumQuantity: "12", discountBps: 1000 }] }, []],
    [{ quantityTiers: [{ minimumQuantity: 12 }] }, []],
    [{ quantityTiers: [{ minimumQuantity: Number.NaN, discountBps: 0 }] }, []],
  ])("drops junk rather than inventing a ladder from it (%j)", (raw, expected) => {
    // Never a *different* ladder: pricing wholesale differently from what was configured
    // is the failure this surface exists to avoid.
    expect(parseSurfaces(raw).quantityTiers).toEqual(expected);
  });

  it("does not disturb the surfaces that were already there", () => {
    const surfaces = parseSurfaces({ base: false, priceLists: ["a", 2, "b"] });

    expect(surfaces.base).toBe(false);
    expect(surfaces.priceLists).toEqual(["a", "b"]);
  });
});
