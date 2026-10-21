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
import {
  ladderOwner,
  planLadderRevert,
  planQuantityBreaks,
  type B2BVariantInput,
  type LadderBaselineInput,
  type TieredCampaign,
} from "./b2b-plan.server";
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

/**
 * A revert's ladders are `resolve(without C)` (rule 6, #704): the next tiered campaign's, by
 * the resolver's own ranking, scope and exclusions, or the merchant's own from the baseline.
 */
describe("recomputing a catalogue's ladders without the campaign that ends", () => {
  const tiered = (id: string, priority: number, tiers: QuantityTier[], over: Partial<TieredCampaign> = {}): TieredCampaign => ({
    id,
    name: `Sale ${id}`,
    priority,
    startAt: 0,
    ruleRows: [],
    compareAtPolicy: { kind: "leave" },
    compareAtViolationPolicy: "clear",
    roundingPolicy: { default: "none", byCurrency: {} } as never,
    guardrailViolationPolicy: "clamp",
    tiers,
    ...over,
  });
  const anchored = (n: number, ladder: LadderBaselineInput["ladder"] = null, over: Partial<LadderBaselineInput> = {}): LadderBaselineInput => ({
    ...variant(n),
    ladder,
    ...over,
  });
  const SIX_FOR_20: QuantityTier[] = [
    { minimumQuantity: 1, discountBps: 0 },
    { minimumQuantity: 6, discountBps: 2000 },
  ];
  const OWN = [{ minimumQuantity: 24, price: gbp(3500) }];
  const ladderOf = (plan: ReturnType<typeof planLadderRevert>, n: number) =>
    plan.rows.find((row) => row.variantGid === variant(n).variantGid)?.breaks.map((b) => [b.minimumQuantity, b.price.amount]);

  it("hands a variant to the next tiered campaign, priced from its own baseline", () => {
    const plan = planLadderRevert([anchored(1, OWN, { baseline: gbp(5000) })], [tiered("low", 100, LADDER)], permissive);

    expect(ladderOf(plan, 1), "the next campaign's ladder was not written").toEqual([[1, 5000], [12, 4500]]);
    expect(plan.handedTo.get(variant(1).variantGid)).toBe("low");
  });

  it("gives a variant nobody else prices its own ladder back, or none", () => {
    const plan = planLadderRevert([anchored(1, OWN), anchored(2)], [], permissive);

    expect(ladderOf(plan, 1)).toEqual([[24, 3500]]);
    expect(ladderOf(plan, 2), "a variant with no ladder before kept one").toEqual([]);
    expect(plan.handedTo.size).toBe(0);
  });

  it("picks the highest-ranked campaign, and the later of two at one priority", () => {
    const low = tiered("low", 100, LADDER);
    const high = tiered("high", 200, SIX_FOR_20);
    expect(ladderOwner(variant(1).variantGid, [low, high])?.id).toBe("high");

    const earlier = tiered("earlier", 100, LADDER, { startAt: 1 });
    const later = tiered("later", 100, SIX_FOR_20, { startAt: 2 });
    expect(ladderOwner(variant(1).variantGid, [later, earlier])?.id).toBe("later");
  });

  it("offers a variant only to campaigns whose scope covers it and that have not let it go", () => {
    const gid = variant(1).variantGid;
    const outOfScope = tiered("elsewhere", 300, SIX_FOR_20, { scope: new Set([variant(2).variantGid]) });
    const letGo = tiered("let-go", 200, SIX_FOR_20, { scope: new Set([gid]), excludedVariantGids: [gid] });
    const covering = tiered("covering", 100, LADDER, { scope: new Set([gid]) });

    const plan = planLadderRevert([anchored(1, OWN)], [outOfScope, letGo, covering], permissive);

    expect(plan.handedTo.get(gid)).toBe("covering");
    expect(ladderOf(plan, 1)).toEqual([[1, 4000], [12, 3600]]);
  });

  it("puts the merchant's own ladder back where the next campaign refuses, and says why", () => {
    const strict: WholesaleGuardrail = { minMarginPercent: 20, missingCost: "refuse" };

    const plan = planLadderRevert([anchored(1, OWN), anchored(2, null, { cost: gbp(1000) })], [tiered("low", 100, LADDER)], strict);

    expect(ladderOf(plan, 1), "a refused variant kept the ending campaign's ladder").toEqual([[24, 3500]]);
    expect(ladderOf(plan, 2)).toEqual([[1, 4000], [12, 3600]]);
    expect(plan.messages.join(" ")).toMatch(/1 product could not take "Sale low"'s quantity breaks.*no cost is recorded/i);
  });
});
