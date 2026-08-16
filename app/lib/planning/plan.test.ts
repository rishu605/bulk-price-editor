import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { money } from "../money/money";
import { NO_ROUNDING } from "../money/rounding";
import type { ResolvableCampaign } from "../pricing/types";
import { planRun, priceDelta, refKey, rowsNeedingWrite } from "./plan";
import { DEFAULT_THRESHOLD, selectWritePath, thresholdFromEnv } from "./write-path";
import type { PlanCandidate, PlanInput, SurfaceRef } from "./types";

const usd = (n: number) => money(n, "USD");

const baseRef = (variantGid: string): SurfaceRef => ({
  variantGid,
  surfaceKind: "base",
  priceListGid: "",
  currency: "USD",
});

function candidate(over: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    ref: baseRef("gid://Variant/1"),
    baseline: { price: usd(10_000) },
    livePrice: usd(10_000),
    ...over,
  };
}

function campaign(over: Partial<ResolvableCampaign> = {}): ResolvableCampaign {
  return {
    id: "c1",
    priority: 100,
    startAt: 1_000,
    ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }],
    compareAtPolicy: { kind: "leave" },
    compareAtViolationPolicy: "clear",
    roundingProfile: NO_ROUNDING,
    guardrailViolationPolicy: "clamp",
    ...over,
  };
}

describe("resolve-diff", () => {
  it("emits a row when the intended price differs from live", () => {
    const out = planRun({ campaigns: [campaign()], candidates: [candidate()] });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].intendedPrice).toEqual(usd(8_000));
    expect(out.rows[0].beforePrice).toEqual(usd(10_000));
    expect(out.counts).toMatchObject({ planned: 1, noop: 0 });
  });

  it("skips no-ops where the storefront already shows the intended price", () => {
    // The second run of a recurring campaign: everything is already correct.
    const out = planRun({
      campaigns: [campaign()],
      candidates: [candidate({ livePrice: usd(8_000) })],
    });
    if (out.kind !== "ok") throw new Error("expected ok");

    expect(out.rows).toHaveLength(0);
    expect(out.counts).toMatchObject({ planned: 0, noop: 1 });
  });

  it("does NOT treat a missing live value as a match", () => {
    // We have no record of what is live, so the safe assumption is that a write is
    // needed. Wrongly skipping would leave a stale price up for the whole campaign.
    const out = planRun({
      campaigns: [campaign()],
      candidates: [candidate({ livePrice: undefined })],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.rows).toHaveLength(1);
    expect(out.counts.noop).toBe(0);
  });

  it("sets up a strike-through alongside the discount", () => {
    const out = planRun({
      campaigns: [campaign({ compareAtPolicy: { kind: "set-to-baseline" } })],
      candidates: [candidate({ livePrice: usd(10_000), liveCompareAt: undefined })],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].intendedPrice).toEqual(usd(8_000));
    expect(out.rows[0].intendedCompareAtSet).toBe(true);
    expect(out.rows[0].intendedCompareAt).toEqual(usd(10_000));
  });

  it("a 0% change cannot create a strike-through, and produces no write", () => {
    // compare-at would equal the price, which shows no saving (E11), so it is
    // cleared -- and clearing an absent compare-at is a no-op. Worth pinning: it is
    // a tempting way to "just add compare-at" that silently does nothing.
    const out = planRun({
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: 0 } }],
          compareAtPolicy: { kind: "set-to-baseline" },
        }),
      ],
      candidates: [candidate({ livePrice: usd(10_000), liveCompareAt: undefined })],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.counts).toMatchObject({ planned: 0, noop: 1 });
  });

  it("distinguishes clear-compare-at from leave-alone", () => {
    const cleared = planRun({
      campaigns: [campaign({ compareAtPolicy: { kind: "clear" } })],
      candidates: [candidate({ liveCompareAt: usd(12_000) })],
    });
    if (cleared.kind !== "ok") throw new Error("expected ok");
    expect(cleared.rows[0].intendedCompareAtSet).toBe(true);
    expect(cleared.rows[0].intendedCompareAt).toBeNull();

    const left = planRun({
      campaigns: [campaign({ compareAtPolicy: { kind: "leave" } })],
      candidates: [candidate({ liveCompareAt: usd(12_000) })],
    });
    if (left.kind !== "ok") throw new Error("expected ok");
    expect(left.rows[0].intendedCompareAtSet).toBe(false);
    expect(left.rows[0].intendedCompareAt).toBeUndefined();
  });

  it("clearing an already-absent compare-at is a no-op", () => {
    const out = planRun({
      campaigns: [
        campaign({
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: 0 } }],
          compareAtPolicy: { kind: "clear" },
        }),
      ],
      candidates: [candidate({ livePrice: usd(10_000), liveCompareAt: undefined })],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.counts).toMatchObject({ planned: 0, noop: 1 });
  });
});

describe("guardrail policy at plan time", () => {
  it("records clamped rows with a reason and still writes them", () => {
    const out = planRun({
      campaigns: [campaign({ guardrailViolationPolicy: "clamp" })],
      candidates: [candidate({ baseline: { price: usd(10_000), cost: usd(9_000) } })],
      storeGuardrails: { neverBelowCost: true },
    });
    if (out.kind !== "ok") throw new Error("expected ok");

    expect(out.rows[0].status).toBe("clamped");
    expect(out.rows[0].intendedPrice).toEqual(usd(9_000));
    expect(out.counts).toMatchObject({ planned: 1, clamped: 1 });
  });

  it("records skipped rows without an intended price", () => {
    const out = planRun({
      campaigns: [campaign({ guardrailViolationPolicy: "skip" })],
      candidates: [candidate({ baseline: { price: usd(10_000), cost: usd(9_000) } })],
      storeGuardrails: { neverBelowCost: true },
    });
    if (out.kind !== "ok") throw new Error("expected ok");

    expect(out.rows[0].status).toBe("skipped");
    expect(out.rows[0].intendedPrice).toBeUndefined();
    expect(out.rows[0].reason).toBe("below-floor");
    expect(out.counts.skipped).toBe(1);
  });

  it("a blocking violation aborts the whole plan, returning no rows", () => {
    // Returning partial rows would let a caller write some of them, which is
    // precisely what "block" has to prevent.
    const out = planRun({
      campaigns: [campaign({ guardrailViolationPolicy: "block" })],
      candidates: [
        candidate({ ref: baseRef("gid://Variant/1") }),
        candidate({
          ref: baseRef("gid://Variant/2"),
          baseline: { price: usd(10_000), cost: usd(9_000) },
        }),
      ],
      storeGuardrails: { neverBelowCost: true },
    });

    expect(out.kind).toBe("blocked");
    if (out.kind !== "blocked") return;
    expect(out.reason).toBe("below-floor");
    expect(out.ref.variantGid).toBe("gid://Variant/2");
    expect(out).not.toHaveProperty("rows");
  });
});

describe("revert planning (invariant I3)", () => {
  it("excluding a campaign falls through to the next, not to baseline", () => {
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

    const out = planRun({
      campaigns: [high, low],
      candidates: [candidate({ livePrice: usd(5_000) })],
      excludeCampaignId: "high",
    });
    if (out.kind !== "ok") throw new Error("expected ok");

    // 90.00 from the still-running sale, NOT 100.00.
    expect(out.rows[0].intendedPrice).toEqual(usd(9_000));
  });

  it("excluding the only campaign restores the baseline", () => {
    const out = planRun({
      campaigns: [campaign({ id: "only" })],
      candidates: [candidate({ livePrice: usd(8_000) })],
      excludeCampaignId: "only",
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.rows[0].intendedPrice).toEqual(usd(10_000));
  });
});

describe("plan properties", () => {
  const anyCandidates = fc.array(
    fc
      .tuple(
        fc.integer({ min: 1, max: 100_000 }),
        fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
        fc.string({ minLength: 1, maxLength: 8 }),
      )
      .map(([basePrice, live, id]) =>
        candidate({
          ref: baseRef(`gid://Variant/${id}`),
          baseline: { price: usd(basePrice) },
          livePrice: live === undefined ? undefined : usd(live),
        }),
      ),
    { maxLength: 25 },
  );

  const anyPlan: fc.Arbitrary<PlanInput> = anyCandidates.map((candidates) => ({
    campaigns: [campaign()],
    candidates,
  }));

  it("counts account for every distinct candidate exactly once", () => {
    fc.assert(
      fc.property(anyPlan, (input) => {
        const out = planRun(input);
        if (out.kind !== "ok") return;
        const distinct = new Set(input.candidates.map((c) => refKey(c.ref))).size;
        const { planned, noop, skipped } = out.counts;
        expect(planned + noop + skipped).toBe(distinct);
      }),
    );
  });

  it("emits at most one row per candidate", () => {
    fc.assert(
      fc.property(anyPlan, (input) => {
        const out = planRun(input);
        if (out.kind !== "ok") return;
        expect(out.rows.length).toBeLessThanOrEqual(input.candidates.length);
        const keys = out.rows.map((r) => r.ref.variantGid);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(anyPlan, (input) => {
        expect(planRun(input)).toEqual(planRun(input));
      }),
    );
  });

  it("re-planning after applying produces nothing (idempotency, I2)", () => {
    // The property that makes recurring campaigns cheap and re-runs safe.
    fc.assert(
      fc.property(anyPlan, (input) => {
        const first = planRun(input);
        if (first.kind !== "ok") return;

        // Simulate every planned row having been written successfully.
        const applied = input.candidates.map((c) => {
          const row = first.rows.find((r) => r.ref.variantGid === c.ref.variantGid);
          if (!row?.intendedPrice) return c;
          return {
            ...c,
            livePrice: row.intendedPrice,
            liveCompareAt:
              row.intendedCompareAtSet && row.intendedCompareAt
                ? row.intendedCompareAt
                : c.liveCompareAt,
          };
        });

        const second = planRun({ ...input, candidates: applied });
        if (second.kind !== "ok") return;
        expect(second.counts.planned).toBe(0);
      }),
    );
  });

  it("every planned row carries a price to write", () => {
    fc.assert(
      fc.property(anyPlan, (input) => {
        const out = planRun(input);
        if (out.kind !== "ok") return;
        for (const row of out.rows) {
          if (row.status === "skipped") expect(row.intendedPrice).toBeUndefined();
          else expect(row.intendedPrice).toBeDefined();
        }
      }),
    );
  });
});

describe("helpers", () => {
  it("rowsNeedingWrite excludes skipped rows", () => {
    const out = planRun({
      campaigns: [campaign({ guardrailViolationPolicy: "skip" })],
      candidates: [
        // Needs a cost of its own: with neverBelowCost set store-wide, a variant
        // with no cost is skipped rather than priced unguarded.
        candidate({ ref: baseRef("v1"), baseline: { price: usd(10_000), cost: usd(2_000) } }),
        candidate({
          ref: baseRef("v2"),
          baseline: { price: usd(10_000), cost: usd(9_000) },
        }),
      ],
      storeGuardrails: { neverBelowCost: true },
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.rows).toHaveLength(2);
    expect(rowsNeedingWrite(out.rows)).toHaveLength(1);
  });

  it("collapses duplicate candidates for the same cell", () => {
    // Upstream queries should never produce these, but a duplicate would violate the
    // ledger's unique constraint at INSERT -- an opaque failure deep in the executor.
    const dup = candidate({ ref: baseRef("dupe") });
    const out = planRun({ campaigns: [campaign()], candidates: [dup, dup] });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.rows).toHaveLength(1);
    expect(out.counts.planned).toBe(1);
  });

  it("priceDelta reports the net change", () => {
    const out = planRun({ campaigns: [campaign()], candidates: [candidate()] });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(priceDelta(out.rows[0])).toEqual(usd(-2_000));
  });
});

describe("write-path selection", () => {
  it("uses sync below the threshold and bulk above it", () => {
    expect(selectWritePath(500).path).toBe("sync");
    expect(selectWritePath(DEFAULT_THRESHOLD).path).toBe("sync");
    expect(selectWritePath(DEFAULT_THRESHOLD + 1).path).toBe("bulk");
  });

  it("prefers bulk when a sync run would not fit the observed budget", () => {
    // 800 rows is under the row threshold, but at 50 points/s a standard shop needs
    // far longer than the 60s ceiling -- row count alone is a poor proxy.
    const decision = selectWritePath(800, {
      restoreRatePerSecond: 50,
      availablePoints: 1_000,
    });
    expect(decision.path).toBe("bulk");
    expect(decision.reason).toContain("rate-limit budget");
  });

  it("keeps the same run on sync for a shop with a faster restore rate", () => {
    const decision = selectWritePath(20, {
      restoreRatePerSecond: 100,
      availablePoints: 2_000,
    });
    expect(decision.path).toBe("sync");
  });

  it("handles an empty plan", () => {
    expect(selectWritePath(0).path).toBe("sync");
    expect(selectWritePath(0).reason).toContain("Nothing");
  });

  it("reads the threshold from the environment, ignoring nonsense", () => {
    expect(thresholdFromEnv({ BULK_PATH_ROW_THRESHOLD: "250" })).toBe(250);
    expect(thresholdFromEnv({})).toBe(DEFAULT_THRESHOLD);
    expect(thresholdFromEnv({ BULK_PATH_ROW_THRESHOLD: "nope" })).toBe(DEFAULT_THRESHOLD);
    expect(thresholdFromEnv({ BULK_PATH_ROW_THRESHOLD: "-5" })).toBe(DEFAULT_THRESHOLD);
  });
});
