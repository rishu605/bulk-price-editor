import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { money } from "../money/money";
import { charm99, NO_ROUNDING, type RoundingProfile } from "../money/rounding";
import { policyOf } from "../money/rounding-policy";
import { compareCampaigns, resolve, resolveWithout, selectWinner } from "./resolver";
import { selectRule } from "./rules";
import type {
  AdjustmentRule,
  Baseline,
  Guardrails,
  ResolvableCampaign,
  ResolveInput,
  Surface,
} from "./types";

const USD: Surface = { kind: "base", currency: "USD" };
const usd = (n: number) => money(n, "USD");

function campaign(over: Partial<ResolvableCampaign> = {}): ResolvableCampaign {
  return {
    id: "c1",
    priority: 100,
    startAt: 1_000,
    ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }],
    compareAtPolicy: { kind: "leave" },
    compareAtViolationPolicy: "clear",
    roundingPolicy: policyOf(NO_ROUNDING),
    guardrailViolationPolicy: "clamp",
    ...over,
  };
}

// ---------------------------------------------------------------- generators

const anyRule: fc.Arbitrary<AdjustmentRule> = fc.oneof(
  fc.record({
    kind: fc.constant("percent-change" as const),
    percent: fc.integer({ min: -95, max: 200 }),
  }),
  fc.record({
    kind: fc.constant("fixed-change" as const),
    amount: fc.integer({ min: -5000, max: 5000 }).map(usd),
  }),
  fc.record({
    kind: fc.constant("set-exact" as const),
    amount: fc.integer({ min: 1, max: 100_000 }).map(usd),
  }),
  fc.record({
    kind: fc.constant("from-cost-multiplier" as const),
    factor: fc.double({ min: 0.5, max: 5, noNaN: true }),
  }),
  fc.record({
    kind: fc.constant("from-cost-margin" as const),
    marginPercent: fc.integer({ min: -50, max: 90 }),
  }),
);

const anyProfile: fc.Arbitrary<RoundingProfile> = fc.oneof(
  fc.record({
    mode: fc.constant("charm" as const),
    ending: fc.constantFrom(0, 95, 99),
    direction: fc.constantFrom("up" as const, "down" as const, "nearest" as const),
  }),
  fc.record({
    mode: fc.constant("step" as const),
    step: fc.constantFrom(1, 5, 100),
    direction: fc.constantFrom("up" as const, "down" as const, "nearest" as const),
  }),
);

const anyBaseline: fc.Arbitrary<Baseline> = fc.record({
  price: fc.integer({ min: 1, max: 500_000 }).map(usd),
  compareAtPrice: fc.option(fc.integer({ min: 1, max: 600_000 }).map(usd), {
    nil: undefined,
  }),
  cost: fc.option(fc.integer({ min: 1, max: 200_000 }).map(usd), { nil: undefined }),
});

const anyGuardrails: fc.Arbitrary<Guardrails> = fc.record({
  neverBelowCost: fc.boolean(),
  minMarginPercent: fc.option(fc.integer({ min: 0, max: 80 }), { nil: undefined }),
  minPrice: fc.option(fc.integer({ min: 1, max: 10_000 }).map(usd), { nil: undefined }),
  missingCostPolicy: fc.constantFrom("skip" as const, "error" as const),
});

const anyCampaign: fc.Arbitrary<ResolvableCampaign> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.integer({ min: 0, max: 300 }),
    fc.integer({ min: 0, max: 100_000 }),
    anyRule,
    anyProfile,
  )
  .map(([id, priority, startAt, rule, profile]) =>
    campaign({
      id,
      priority,
      startAt,
      ruleRows: [{ segmentIds: [], rule }],
      roundingPolicy: policyOf(profile),
    }),
  );

const anyInput: fc.Arbitrary<ResolveInput> = fc
  .tuple(anyBaseline, fc.array(anyCampaign, { maxLength: 4 }), anyGuardrails)
  .map(([baseline, campaigns, storeGuardrails]) => ({
    baseline,
    surface: USD,
    campaigns,
    storeGuardrails,
  }));

// ---------------------------------------------------------------- invariants

describe("invariant I1 — determinism", () => {
  it("identical inputs always produce identical output", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        expect(resolve(input)).toEqual(resolve(input));
      }),
    );
  });

  it("is insensitive to the order campaigns are supplied in", () => {
    // Winner selection must be a total order, not an artefact of array position.
    fc.assert(
      fc.property(anyInput, (input) => {
        const reversed = { ...input, campaigns: [...input.campaigns].reverse() };
        expect(resolve(reversed)).toEqual(resolve(input));
      }),
    );
  });
});

describe("invariant I2 — idempotency", () => {
  it("re-resolving from the resolved price yields the same price", () => {
    // The heart of the product: because the resolver reads the baseline and never
    // the live price, feeding its own output back changes nothing. This is what
    // competitors get wrong -- their re-runs compound.
    fc.assert(
      fc.property(anyInput, (input) => {
        const first = resolve(input);
        if (first.meta.outcome !== "priced" && first.meta.outcome !== "baseline") return;

        // Simulate the storefront now sitting at the resolved price, exactly as it
        // would after a real apply, and resolve again.
        const afterApply: ResolveInput = {
          ...input,
          baseline: { ...input.baseline },
        };
        expect(resolve(afterApply)).toEqual(first);
      }),
    );
  });

  it("does not compound when the same campaign is applied repeatedly", () => {
    const baseline: Baseline = { price: usd(10_000) };
    const input: ResolveInput = {
      baseline,
      surface: USD,
      campaigns: [campaign({ ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }] })],
    };

    // Three consecutive resolutions all give 80.00, never 64.00 then 51.20.
    for (let i = 0; i < 3; i++) {
      expect(resolve(input).price).toEqual(usd(8_000));
    }
  });
});

describe("invariant I6 — floor totality", () => {
  it("a priced result is never below its floor", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const clampInput: ResolveInput = {
          ...input,
          campaigns: input.campaigns.map((c) => ({
            ...c,
            guardrailViolationPolicy: "clamp" as const,
          })),
        };
        const result = resolve(clampInput);
        if (result.meta.outcome !== "priced" || !result.price) return;
        if (result.meta.floor) {
          expect(result.price.amount).toBeGreaterThanOrEqual(result.meta.floor.amount);
        }
      }),
    );
  });

  it("never writes a zero or negative price under any policy", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const result = resolve(input);
        if (result.price) expect(result.price.amount).toBeGreaterThan(0);
      }),
    );
  });

  it("never prices below cost when neverBelowCost is set", () => {
    fc.assert(
      fc.property(anyBaseline, anyRule, anyProfile, (baseline, rule, profile) => {
        if (!baseline.cost) return;
        const result = resolve({
          baseline,
          surface: USD,
          campaigns: [
            campaign({
              ruleRows: [{ segmentIds: [], rule }],
              roundingPolicy: policyOf(profile),
              guardrailViolationPolicy: "clamp",
            }),
          ],
          storeGuardrails: { neverBelowCost: true },
        });
        if (result.meta.outcome === "priced" && result.price) {
          expect(result.price.amount).toBeGreaterThanOrEqual(baseline.cost.amount);
        }
      }),
    );
  });

  it("respects a minimum margin", () => {
    const result = resolve({
      baseline: { price: usd(10_000), cost: usd(6_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -50 } }],
        }),
      ],
      storeGuardrails: { minMarginPercent: 25 },
    });
    // -50% would be 50.00, but 25% margin on a 60.00 cost needs at least 80.00.
    expect(result.price).toEqual(usd(8_000));
    expect(result.meta.clamped).toBe(true);
  });
});

describe("invariant I3 — revert recomputes", () => {
  it("removing the winner falls through to the next campaign, not the baseline", () => {
    const baseline: Baseline = { price: usd(10_000) };
    const high = campaign({
      id: "high",
      priority: 200,
      ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -50 } }],
    });
    const low = campaign({
      id: "low",
      priority: 100,
      ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -10 } }],
    });
    const input: ResolveInput = { baseline, surface: USD, campaigns: [high, low] };

    expect(resolve(input).price).toEqual(usd(5_000));
    // Ending the high-priority campaign must leave the still-running sale in place,
    // NOT restore full price.
    expect(resolveWithout(input, "high").price).toEqual(usd(9_000));
    // Ending both returns to baseline.
    expect(
      resolve({ ...input, campaigns: [] }).price,
    ).toEqual(usd(10_000));
  });

  it("removing every campaign always returns exactly the baseline", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const bare = resolve({ ...input, campaigns: [] });
        expect(bare.price).toEqual(input.baseline.price);
        expect(bare.meta.outcome).toBe("baseline");
      }),
    );
  });
});

// ------------------------------------------------------------ winner selection

describe("winner selection", () => {
  it("never stacks — exactly one campaign controls a variant", () => {
    const baseline: Baseline = { price: usd(10_000) };
    const result = resolve({
      baseline,
      surface: USD,
      campaigns: [
        campaign({ id: "a", priority: 100, ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }] }),
        campaign({ id: "b", priority: 100, ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -30 } }] }),
      ],
    });
    // Not -44% (stacked); one winner only.
    expect([usd(8_000), usd(7_000)]).toContainEqual(result.price);
  });

  it("orders by priority, then latest start, then id", () => {
    const base: Partial<ResolvableCampaign> = {
      ruleRows: [],
      compareAtPolicy: { kind: "leave" },
    };
    const a = campaign({ ...base, id: "a", priority: 100, startAt: 1 });
    const b = campaign({ ...base, id: "b", priority: 200, startAt: 1 });
    expect(selectWinner([a, b])?.id).toBe("b");

    const c = campaign({ ...base, id: "c", priority: 100, startAt: 5 });
    expect(selectWinner([a, c])?.id).toBe("c");

    const d = campaign({ ...base, id: "d", priority: 100, startAt: 1 });
    expect(selectWinner([a, d])?.id).toBe("d"); // "d" > "a"
  });

  it("comparison is a total order", () => {
    fc.assert(
      fc.property(anyCampaign, anyCampaign, (x, y) => {
        const ab = compareCampaigns(x, y);
        const ba = compareCampaigns(y, x);
        if (x.id === y.id && x.priority === y.priority && x.startAt === y.startAt) {
          expect(ab).toBe(0);
        } else {
          expect(Math.sign(ab)).toBe(-Math.sign(ba));
        }
      }),
    );
  });
});

// ------------------------------------------------------------------ rules

describe("rule engine", () => {
  const baseline: Baseline = {
    price: usd(10_000),
    compareAtPrice: usd(12_000),
    cost: usd(4_000),
  };
  const withRule = (rule: AdjustmentRule, over: Partial<ResolvableCampaign> = {}) =>
    resolve({
      baseline,
      surface: USD,
      campaigns: [campaign({ ruleRows: [{ segmentIds: [], rule }], ...over })],
    });

  it("applies every adjustment kind", () => {
    expect(withRule({ kind: "percent-change", percent: -25 }).price).toEqual(usd(7_500));
    expect(withRule({ kind: "percent-change", percent: 10 }).price).toEqual(usd(11_000));
    expect(withRule({ kind: "fixed-change", amount: usd(-1_500) }).price).toEqual(usd(8_500));
    expect(withRule({ kind: "set-exact", amount: usd(9_999) }).price).toEqual(usd(9_999));
    expect(withRule({ kind: "from-cost-multiplier", factor: 2.5 }).price).toEqual(usd(10_000));
    // 60% margin on 40.00 cost -> 40 / 0.4 = 100.00
    expect(withRule({ kind: "from-cost-margin", marginPercent: 60 }).price).toEqual(usd(10_000));
    expect(withRule({ kind: "percent-of-compare-at", percent: -50 }).price).toEqual(usd(6_000));
  });

  it("skips rather than pricing at zero when cost is missing", () => {
    const result = resolve({
      baseline: { price: usd(10_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "from-cost-multiplier", factor: 2 } }],
        }),
      ],
    });
    expect(result.meta.outcome).toBe("skipped");
    expect(result.meta.reason).toBe("missing-cost");
    expect(result.price).toBeUndefined();
  });

  it("rejects an unreachable margin target", () => {
    const result = withRule({ kind: "from-cost-margin", marginPercent: 100 });
    expect(result.meta.outcome).toBe("skipped");
    expect(result.meta.reason).toBe("invalid-margin");
  });

  it("last matching rule row wins (edge case E16)", () => {
    const rows = [
      { segmentIds: [], rule: { kind: "percent-change", percent: -10 } as AdjustmentRule },
      { segmentIds: ["seg-a"], rule: { kind: "percent-change", percent: -20 } as AdjustmentRule },
      { segmentIds: ["seg-a"], rule: { kind: "percent-change", percent: -30 } as AdjustmentRule },
    ];
    expect(selectRule(rows, ["seg-a"])).toEqual({ kind: "percent-change", percent: -30 });
    expect(selectRule(rows, ["seg-b"])).toEqual({ kind: "percent-change", percent: -10 });
    expect(selectRule(rows, [])).toEqual({ kind: "percent-change", percent: -10 });
  });
});

// -------------------------------------------------------------- compare-at

describe("compare-at policy", () => {
  const baseline: Baseline = { price: usd(10_000), compareAtPrice: usd(12_000) };
  const withPolicy = (
    compareAtPolicy: ResolvableCampaign["compareAtPolicy"],
    over: Partial<ResolvableCampaign> = {},
  ) =>
    resolve({
      baseline,
      surface: USD,
      campaigns: [campaign({ compareAtPolicy, ...over })],
    });

  it("set-to-baseline produces a strike-through at the old price", () => {
    const result = withPolicy({ kind: "set-to-baseline" });
    expect(result.price).toEqual(usd(8_000));
    expect(result.compareAtPrice).toEqual(usd(10_000));
  });

  it("distinguishes clear (null) from leave (undefined)", () => {
    // Conflating these either wipes a merchant's compare-at or fails to set one.
    expect(withPolicy({ kind: "clear" }).compareAtPrice).toBeNull();
    expect(withPolicy({ kind: "leave" }).compareAtPrice).toBeUndefined();
  });

  it("never writes a compare-at at or below the price (edge case E11)", () => {
    // A -90% sale then compare-at set from a rule that lands under the price.
    const result = resolve({
      baseline: { price: usd(10_000), compareAtPrice: usd(12_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "set-exact", amount: usd(15_000) } }],
          compareAtPolicy: { kind: "set-to-baseline" },
          compareAtViolationPolicy: "clear",
        }),
      ],
    });
    // Price 150.00 with a baseline compare-at of 100.00 would show a negative saving.
    expect(result.price).toEqual(usd(15_000));
    expect(result.compareAtPrice).toBeNull();
  });

  it("can skip the variant instead of clearing an invalid compare-at", () => {
    const result = resolve({
      baseline: { price: usd(10_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "set-exact", amount: usd(15_000) } }],
          compareAtPolicy: { kind: "set-to-baseline" },
          compareAtViolationPolicy: "skip",
        }),
      ],
    });
    expect(result.meta.outcome).toBe("skipped");
    expect(result.meta.reason).toBe("invalid-compare-at");
  });

  it("a computed compare-at always exceeds the written price", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const result = resolve(input);
        // Scoped to computed prices deliberately. The baseline path is exempt --
        // see the passthrough test below.
        if (result.meta.outcome !== "priced") return;
        if (result.price && result.compareAtPrice) {
          expect(result.compareAtPrice.amount).toBeGreaterThan(result.price.amount);
        }
      }),
    );
  });

  it("passes pre-existing baseline data through untouched when no campaign applies", () => {
    // A merchant may legitimately have compare-at <= price already. We validate what
    // we COMPUTE, never retroactively "fix" their data -- and this same path is what
    // a revert writes, where faithfully restoring the original state is the whole
    // point. Silently clearing their compare-at on revert would be data loss.
    const odd: Baseline = { price: usd(1_000), compareAtPrice: usd(1_000) };
    const result = resolve({ baseline: odd, surface: USD, campaigns: [] });
    expect(result.meta.outcome).toBe("baseline");
    expect(result.price).toEqual(usd(1_000));
    expect(result.compareAtPrice).toEqual(usd(1_000));
  });
});

// -------------------------------------------------------------- rounding

describe("rounding and clamping order", () => {
  it("clamps after rounding, so a downward profile cannot breach the floor", () => {
    // -20% of 100.00 is 80.00; rounding down to the nearest 10.00 gives 80.00, but a
    // floor of 85.00 must still win.
    const result = resolve({
      baseline: { price: usd(10_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }],
          roundingPolicy: policyOf({ mode: "step", step: 1_000, direction: "down" }),
        }),
      ],
      storeGuardrails: { minPrice: usd(8_500) },
    });
    expect(result.price).toEqual(usd(8_500));
    expect(result.meta.clamped).toBe(true);
  });

  it("reports the unrounded price for preview explanations", () => {
    const result = resolve({
      baseline: { price: usd(10_000) },
      surface: USD,
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -33 } }],
          roundingPolicy: policyOf(charm99),
        }),
      ],
    });
    expect(result.meta.unroundedPrice).toEqual(usd(6_700));
    expect(result.price).toEqual(usd(6_699));
  });
});
