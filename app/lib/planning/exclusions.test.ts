/**
 * Variant-level exclusion: pulling one variant out of a running campaign.
 *
 * The interesting case is not "the campaign stops pricing it" — it is *what price it
 * lands on*. Excluding a variant is resolution with that campaign removed for that
 * variant, so it falls through to whatever else still controls it. A variant pulled
 * out of a 30% sale that also sits inside a 10% one belongs at 10%, not at full
 * price, and an implementation that filtered the candidate out upstream would
 * silently produce the latter — quietly ending a sale the merchant never ended.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { NO_ROUNDING } from "../money/rounding";
import type { ResolvableCampaign } from "../pricing/types";
import { planRun } from "./plan";
import type { PlanCandidate, SurfaceRef } from "./types";

const usd = (n: number) => money(n, "USD");

const ref = (variantGid: string): SurfaceRef => ({
  variantGid,
  surfaceKind: "base",
  priceListGid: "",
  currency: "USD",
});

function candidate(variantGid: string, live = 10_000): PlanCandidate {
  return { ref: ref(variantGid), baseline: { price: usd(10_000) }, livePrice: usd(live) };
}

function campaign(over: Partial<ResolvableCampaign> = {}): ResolvableCampaign {
  return {
    id: "c1",
    priority: 100,
    startAt: 1_000,
    ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -30 } }],
    compareAtPolicy: { kind: "leave" },
    compareAtViolationPolicy: "clear",
    roundingProfile: NO_ROUNDING,
    guardrailViolationPolicy: "clamp",
    ...over,
  };
}

const rowFor = (out: ReturnType<typeof planRun>, variantGid: string) => {
  if (out.kind !== "ok") throw new Error(`plan was ${out.kind}`);
  return out.rows.find((row) => row.ref.variantGid === variantGid);
};

describe("variant-level exclusion", () => {
  it("returns an excluded variant to baseline when nothing else controls it", () => {
    const out = planRun({
      campaigns: [campaign({ excludedVariantGids: ["gid://Variant/1"] })],
      // Currently sitting at the campaign price, so the revert has real work to do.
      candidates: [candidate("gid://Variant/1", 7_000)],
    });

    expect(rowFor(out, "gid://Variant/1")?.intendedPrice).toEqual(usd(10_000));
  });

  it("leaves other variants in the campaign untouched", () => {
    const out = planRun({
      campaigns: [campaign({ excludedVariantGids: ["gid://Variant/1"] })],
      candidates: [candidate("gid://Variant/1", 7_000), candidate("gid://Variant/2")],
    });

    expect(rowFor(out, "gid://Variant/1")?.intendedPrice).toEqual(usd(10_000));
    expect(rowFor(out, "gid://Variant/2")?.intendedPrice).toEqual(usd(7_000));
  });

  it("falls through to the next campaign rather than to full price", () => {
    // The claim this whole mechanism rests on. Excluding the winner must re-resolve,
    // not skip: the variant is still in a 10% sale and must land there.
    const out = planRun({
      campaigns: [
        campaign({ id: "sale-30", priority: 200, excludedVariantGids: ["gid://Variant/1"] }),
        campaign({
          id: "sale-10",
          priority: 100,
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -10 } }],
        }),
      ],
      candidates: [candidate("gid://Variant/1", 7_000)],
    });

    expect(rowFor(out, "gid://Variant/1")?.intendedPrice).toEqual(usd(9_000));
  });

  it("only excludes for the campaign that names the variant", () => {
    // Exclusions are per campaign, not per variant. A variant pulled out of one sale
    // is still fully enrolled in every other.
    const out = planRun({
      campaigns: [
        campaign({ id: "sale-30", priority: 200, excludedVariantGids: ["gid://Variant/2"] }),
        campaign({
          id: "sale-10",
          priority: 100,
          ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -10 } }],
          excludedVariantGids: ["gid://Variant/1"],
        }),
      ],
      candidates: [candidate("gid://Variant/1", 10_000), candidate("gid://Variant/2", 10_000)],
    });

    // Variant 1 is excluded from the 10% sale, but the 30% sale still wins outright.
    expect(rowFor(out, "gid://Variant/1")?.intendedPrice).toEqual(usd(7_000));
    // Variant 2 is excluded from the 30% sale, so the 10% one takes over.
    expect(rowFor(out, "gid://Variant/2")?.intendedPrice).toEqual(usd(9_000));
  });

  it("plans nothing when the excluded variant is already at the right price", () => {
    // Exclusion is not a reason to write. If the variant already sits where
    // resolve-without-the-campaign puts it, there is nothing to do, and writing
    // anyway would spend rate limit to change nothing.
    const out = planRun({
      campaigns: [campaign({ excludedVariantGids: ["gid://Variant/1"] })],
      candidates: [candidate("gid://Variant/1", 10_000)],
    });

    if (out.kind !== "ok") throw new Error("plan was blocked");
    expect(out.rows).toHaveLength(0);
    expect(out.counts.noop).toBe(1);
  });

  it("costs nothing when no campaign excludes anything", () => {
    // The common case. Guarded so the per-candidate filter is skipped entirely
    // rather than rebuilt for every variant in a 100K-variant catalogue.
    const out = planRun({
      campaigns: [campaign()],
      candidates: [candidate("gid://Variant/1")],
    });

    expect(rowFor(out, "gid://Variant/1")?.intendedPrice).toEqual(usd(7_000));
  });
});
