/**
 * What each plan gates, and what it must never gate.
 *
 * The tests that matter most here are the negatives. A gate that fires when it should
 * not costs a merchant a feature they paid for; a gate that fires on a *revert* strands
 * a storefront at sale prices, which is a revenue incident we caused (E8).
 */

import { describe, expect, it } from "vitest";

import * as plans from "./plans";
import {
  canStart,
  canUseSurface,
  losesOnDowngrade,
  PLANS,
  planFor,
} from "./plans";

const shape = (over: Partial<Parameters<typeof canStart>[1]> = {}) => ({
  variants: 100,
  markets: false,
  b2b: false,
  ...over,
});

describe("starting a campaign", () => {
  it("lets a small campaign run on the free plan", () => {
    expect(canStart(PLANS.free, shape())).toEqual({ allowed: true });
  });

  it("stops a campaign above the plan's variant limit, and says by how much", () => {
    const verdict = canStart(PLANS.free, shape({ variants: 900 }));

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("variant-limit");
      expect(verdict.message).toContain("500");
      expect(verdict.message).toContain("900");
      expect(verdict.upgradeTo).toBe("growth");
    }
  });

  it("names the cheapest plan that would actually cover the campaign", () => {
    // Not simply "the next one up". A 50,000-variant campaign needs Markets, and
    // pointing a merchant at Growth would sell them an upgrade that still refuses.
    const verdict = canStart(PLANS.free, shape({ variants: 50_000 }));

    expect(!verdict.allowed && verdict.upgradeTo).toBe("markets");
  });

  it("gates markets below the Markets plan", () => {
    const verdict = canStart(PLANS.growth, shape({ markets: true }));

    expect(!verdict.allowed && verdict.reason).toBe("markets");
    expect(!verdict.allowed && verdict.upgradeTo).toBe("markets");
  });

  it("gates B2B below Wholesale", () => {
    const verdict = canStart(PLANS.markets, shape({ b2b: true }));

    expect(!verdict.allowed && verdict.upgradeTo).toBe("wholesale");
  });

  it("reports the surface gate before the size gate", () => {
    // A campaign that is both too big and on a gated surface should be told about the
    // surface: it is the concrete, fixable thing, and the size limit on the plan that
    // unlocks the surface is usually different anyway.
    const verdict = canStart(PLANS.free, shape({ variants: 900, markets: true }));

    expect(!verdict.allowed && verdict.reason).toBe("markets");
  });

  it("lets any size run on the unlimited plan", () => {
    expect(canStart(PLANS.wholesale, shape({ variants: 5_000_000 })).allowed).toBe(true);
  });

  it("allows a campaign exactly at the limit", () => {
    // Off-by-one here is a merchant told their 10,000-variant catalogue needs the next
    // plan up when the plan they bought says 10,000.
    expect(canStart(PLANS.growth, shape({ variants: 10_000 })).allowed).toBe(true);
    expect(canStart(PLANS.growth, shape({ variants: 10_001 })).allowed).toBe(false);
  });
});

describe("choosing a surface", () => {
  it("never gates the base price", () => {
    // The base price is the product. A plan that could not change it would not be a
    // plan, it would be a lock screen.
    for (const plan of Object.values(PLANS)) {
      expect(canUseSurface(plan, "base").allowed).toBe(true);
    }
  });

  it("gates a market on the plans without it, and offers the one with it", () => {
    const verdict = canUseSurface(PLANS.free, "market");

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.upgradeTo).toBe("markets");
  });

  it("allows a market on Markets and above", () => {
    expect(canUseSurface(PLANS.markets, "market").allowed).toBe(true);
    expect(canUseSurface(PLANS.wholesale, "market").allowed).toBe(true);
  });
});

describe("safety is never gated", () => {
  it("has no plan on which a revert can be refused", () => {
    // Asserted as an absence, deliberately. There is no `canRevert` in this module,
    // because a merchant who downgrades mid-campaign must still get their scheduled
    // revert — anything else leaves discounted prices live indefinitely (E8).
    expect(Object.keys(plans)).not.toContain("canRevert");
    expect(Object.keys(plans)).not.toContain("canPreview");
    expect(Object.keys(plans)).not.toContain("canRollback");
  });

  it("gives the free plan a real catalogue rather than a demo", () => {
    // The merchants who most need guardrails and rollback are the ones on the free
    // tier. A cap that only permits a toy makes it an advertisement, not a product.
    expect(PLANS.free.variantLimit).toBeGreaterThanOrEqual(500);
  });
});

describe("what a downgrade costs", () => {
  it("names the surfaces that will stop being available", () => {
    expect(losesOnDowngrade(PLANS.wholesale, PLANS.growth)).toEqual([
      "markets",
      "b2b",
      "variant-limit",
    ]);
  });

  it("says nothing is lost when the plan is unchanged", () => {
    expect(losesOnDowngrade(PLANS.markets, PLANS.markets)).toEqual([]);
  });

  it("says nothing is lost on an upgrade", () => {
    expect(losesOnDowngrade(PLANS.free, PLANS.wholesale)).toEqual([]);
  });

  it("counts losing an unlimited catalogue as a loss", () => {
    expect(losesOnDowngrade(PLANS.wholesale, PLANS.markets)).toContain("variant-limit");
  });
});

describe("reading a stored plan", () => {
  it("falls back to free rather than throwing on an unknown value", () => {
    // A plan id from a future release, or a botched webhook. Free is the safe default:
    // it constrains what can be started and gates nothing that matters for safety.
    expect(planFor("enterprise-plus").id).toBe("free");
    expect(planFor(undefined).id).toBe("free");
    expect(planFor(null).id).toBe("free");
  });
});
