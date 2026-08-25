import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { assignEnrollments, type CampaignMatch } from "./assign";
import { selectWinner } from "../pricing/resolver";
import type { ResolvableCampaign } from "../pricing/types";
import { NO_ROUNDING } from "../money/rounding";
import { policyOf } from "../money/rounding-policy";

const campaign = (
  id: string,
  priority: number,
  startAt = 1_000,
): ResolvableCampaign => ({
  id,
  priority,
  startAt,
  ruleRows: [],
  compareAtPolicy: { kind: "leave" },
  compareAtViolationPolicy: "clear",
  roundingPolicy: policyOf(NO_ROUNDING),
  guardrailViolationPolicy: "clamp",
});

const match = (
  c: ResolvableCampaign,
  matched: string[],
  alreadyPriced: string[] = [],
): CampaignMatch => ({
  campaign: c,
  matched,
  alreadyPriced: new Set(alreadyPriced),
});

describe("assignEnrollments", () => {
  it("enrolls a variant into the campaign that will actually price it", () => {
    const low = campaign("low", 10);
    const high = campaign("high", 90);

    const result = assignEnrollments([match(low, ["v1"]), match(high, ["v1"])]);

    // Only the winner. Enrolling it into `low` as well would queue a re-apply for a
    // campaign that then declines to price it, leaving it pending forever.
    expect(result).toEqual([{ campaignId: "high", enroll: ["v1"] }]);
  });

  it("says nothing when the winner has already priced the variant", () => {
    // The case that matters most in production: product-update webhooks fire for
    // stock, title and tag edits constantly. Treating every match as an enrollment
    // would re-run every active campaign on every one of them.
    const c = campaign("c", 50);
    expect(assignEnrollments([match(c, ["v1", "v2"], ["v1", "v2"])])).toEqual([]);
  });

  it("enrolls only the part of a batch the winner has not priced", () => {
    const c = campaign("c", 50);
    expect(assignEnrollments([match(c, ["v1", "v2", "v3"], ["v2"])])).toEqual([
      { campaignId: "c", enroll: ["v1", "v3"] },
    ]);
  });

  it("does not fall back to a losing campaign when the winner already priced it", () => {
    // `high` owns v1 and has priced it. `low` also matches v1, but v1 is settled --
    // it must not be handed to `low`, which would fight the resolver every tick.
    const low = campaign("low", 10);
    const high = campaign("high", 90);

    expect(assignEnrollments([match(low, ["v1"]), match(high, ["v1"], ["v1"])])).toEqual([]);
  });

  it("splits a batch across the campaigns that respectively win each variant", () => {
    const a = campaign("a", 90);
    const b = campaign("b", 10);

    const result = assignEnrollments([match(a, ["v1"]), match(b, ["v1", "v2"])]);

    expect(result).toEqual(
      expect.arrayContaining([
        { campaignId: "a", enroll: ["v1"] },
        { campaignId: "b", enroll: ["v2"] },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it("has nothing to do for an empty batch or no active campaigns", () => {
    expect(assignEnrollments([])).toEqual([]);
    expect(assignEnrollments([match(campaign("c", 50), [])])).toEqual([]);
  });

  it("agrees with the resolver about who wins, for any set of campaigns", () => {
    // The invariant this module exists to hold. If enrollment and the resolver ever
    // disagreed, an enrolled variant would be queued against a campaign that then
    // refuses to price it, and the campaign would never stop being pending.
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }),
            priority: fc.integer({ min: -100, max: 100 }),
            startAt: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 1, maxLength: 6, selector: (c) => c.id },
        ),
        (specs) => {
          const campaigns = specs.map((s) => campaign(s.id, s.priority, s.startAt));
          const assignments = assignEnrollments(
            campaigns.map((c) => match(c, ["v1"])),
          );

          const expected = selectWinner(campaigns)!;
          expect(assignments).toEqual([{ campaignId: expected.id, enroll: ["v1"] }]);
        },
      ),
    );
  });

  it("assigns every variant to exactly one campaign", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (priorities, variantGids) => {
          const matches = priorities.map((priority, index) =>
            match(campaign(`c${index}`, priority), variantGids),
          );

          const enrolled = assignEnrollments(matches).flatMap((a) => a.enroll);

          expect(new Set(enrolled).size).toBe(enrolled.length);
          expect(enrolled.sort()).toEqual([...variantGids].sort());
        },
      ),
    );
  });
});
