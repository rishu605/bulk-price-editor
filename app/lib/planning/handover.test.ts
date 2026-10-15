/**
 * Which campaign a revert handed a variant to (#998).
 *
 * The live shape: A (priority 100, 10% off) and B (priority 200, 30% off) over one variant
 * at $100.00. B ends, and its revert writes A's $90.00 -- ledgered under B's revert, so only
 * the planner can say the price is A's.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { NO_ROUNDING } from "../money/rounding";
import { policyOf } from "../money/rounding-policy";
import type { ResolvableCampaign } from "../pricing/types";
import { inheritors } from "./handover";
import type { PlanCandidate } from "./types";

const V = "gid://shopify/ProductVariant/1";
const W = "gid://shopify/ProductVariant/2";

const candidate = (variantGid: string, cents = 10_000): PlanCandidate => ({
  ref: { variantGid, surfaceKind: "base", priceListGid: "", currency: "USD" },
  baseline: { price: money(cents, "USD") },
  // What the mirror says now, which may be a hand edit: never what is compared.
  livePrice: money(4_200, "USD"),
});

function sale(id: string, priority: number, percent: number, scope?: string[], over: Partial<ResolvableCampaign> = {}): ResolvableCampaign {
  return {
    id,
    priority,
    startAt: 1_000,
    ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent } }],
    compareAtPolicy: { kind: "leave" },
    compareAtViolationPolicy: "clear",
    roundingPolicy: policyOf(NO_ROUNDING),
    guardrailViolationPolicy: "clamp",
    scope: scope ? new Set(scope) : undefined,
    ...over,
  };
}

const A = (scope: string[] = [V], over: Partial<ResolvableCampaign> = {}) => sale("A", 100, -10, scope, over);

describe("who a revert handed a variant to (#998)", () => {
  it("is the campaign whose price the revert wrote", () => {
    const found = inheritors({ campaigns: [A()], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("A");
  });

  it("is judged by what the revert wrote, not by what is live now", () => {
    // The hand edit to $42.00 is the thing drift is asking about; the price it replaced is A's.
    const found = inheritors({ campaigns: [A()], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("A");
  });

  it("is the winner, not an older campaign that also covers it", () => {
    // C (priority 50) wrote the variant before B took it over; A was applied under B and
    // never wrote it. The newest ledger row by a campaign still running is C's -- the wrong
    // answer the drift lookup used to give.
    const C = sale("C", 50, -20, [V]);
    const found = inheritors({ campaigns: [C, A()], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("A");
  });

  it("is nobody when the revert put the baseline back", () => {
    const found = inheritors({ campaigns: [A([W])], candidates: [candidate(V)], handedOver: new Map([[V, 10_000]]) });
    expect(found.has(V)).toBe(false);
  });

  it("is nobody when the price written is no running campaign's", () => {
    const found = inheritors({ campaigns: [A()], candidates: [candidate(V)], handedOver: new Map([[V, 8_500]]) });
    expect(found.has(V)).toBe(false);
  });

  it("is nobody when the revert put the baseline back, whatever an unrelated rule lands on", () => {
    // Z covers nothing here and its rule gives the baseline itself. Scope-blind, it matches.
    const Z = sale("Z", 300, 0, [W]);
    const found = inheritors({ campaigns: [Z, A([W])], candidates: [candidate(V)], handedOver: new Map([[V, 10_000]]) });
    expect(found.has(V)).toBe(false);
  });

  it("is still the campaign after the product has left its scope", () => {
    // Archived after B's revert (#751): A's scope no longer covers it, and A's price is live.
    const found = inheritors({ campaigns: [A([W])], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("A");
  });

  it("prefers a campaign covering it now over one whose scope it has left", () => {
    // D covers it now at the same price A's rule gives: the resolver's answer comes first.
    const D = sale("D", 10, -10, [V]);
    const found = inheritors({ campaigns: [A([W]), D], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("D");
  });

  it("looks past a campaign covering it now at another price", () => {
    const D = sale("D", 300, -50, [V]);
    const found = inheritors({ campaigns: [A([W]), D], candidates: [candidate(V)], handedOver: new Map([[V, 9_000]]) });
    expect(found.get(V)).toBe("A");
  });

  it("is never a campaign that has let the variant go", () => {
    const found = inheritors({
      campaigns: [A([V], { excludedVariantGids: [V] })],
      candidates: [candidate(V)],
      handedOver: new Map([[V, 9_000]]),
    });
    expect(found.has(V)).toBe(false);
  });

  it("is the campaign holding a hand edit on it", () => {
    const found = inheritors({
      campaigns: [A()],
      candidates: [candidate(V)],
      handedOver: new Map([[V, 9_000]]),
      heldEdits: new Map([[V, "A"]]),
    });
    expect(found.get(V)).toBe("A");
  });

  it("is the campaign holding a hand edit, not a higher one whose rule happens to give the same price", () => {
    // E outranks A and gives the same $90.00, but covers nothing here: without the hold
    // counting, the scope-blind pass would hand the edit A is asking about to E.
    const E = sale("E", 300, -10, [W]);
    const found = inheritors({
      campaigns: [E, A()],
      candidates: [candidate(V)],
      handedOver: new Map([[V, 9_000]]),
      heldEdits: new Map([[V, "A"]]),
    });
    expect(found.get(V)).toBe("A");
  });

  it("answers for the rest when one variant's guardrail blocks", () => {
    // X blocks on W, which stops a whole plan. V is still D's -- the resolver's winner over
    // the scopes as they are -- not E's, which outranks D but covers neither.
    const X = sale("X", 500, -95, [W], { guardrailViolationPolicy: "block", guardrails: { minPrice: money(5_000, "USD") } });
    const E = sale("E", 400, -10, []);
    const D = sale("D", 50, -10, [V]);
    const found = inheritors({
      campaigns: [X, E, D],
      candidates: [candidate(W), candidate(V)],
      handedOver: new Map([
        [V, 9_000],
        [W, 9_000],
      ]),
    });
    expect(found.get(V)).toBe("D");
  });

  it("answers only for the variants it was told a revert wrote", () => {
    const found = inheritors({ campaigns: [A([V, W])], candidates: [candidate(V), candidate(W)], handedOver: new Map([[V, 9_000]]) });
    expect([...found.keys()]).toEqual([V]);
  });
});
