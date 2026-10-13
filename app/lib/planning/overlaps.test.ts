/**
 * Which campaigns share a campaign's variants, and who prices them (#821).
 *
 * Read off the planner's coverage, the resolver's answer for every candidate. It used to
 * be read off the planned rows, which leave out a variant already at its price: exactly
 * the variant another campaign keeps. A sale entirely under a higher-priority one then
 * found no overlap at all.
 */

import { describe, expect, it } from "vitest";

import { overlapSentences, overlapsFrom } from "./overlaps";
import type { PlanCoverage } from "./types";

const OTHERS = [
  { id: "c_autumn", name: "Autumn sale", priority: 200, status: "ACTIVE" },
  { id: "c_clear", name: "Clearance", priority: 50, status: "HELD" },
];

const cover = (campaignId: string, covers: number, wins: number, yieldsTo: Record<string, number> = {}): PlanCoverage => ({
  campaignId,
  covers,
  wins,
  yieldsTo,
});

describe("reading overlap from the planner's coverage", () => {
  it("reports what each other campaign keeps, and what it yields to this one", () => {
    const found = overlapsFrom(
      [cover("draft", 10, 6, { c_autumn: 0 }), cover("c_autumn", 4, 4), cover("c_clear", 7, 0, { draft: 6, c_autumn: 1 })],
      "draft",
      OTHERS,
    );

    expect(found).toEqual([
      { campaignId: "c_clear", name: "Clearance", priority: 50, status: "HELD", keeps: 0, yields: 6 },
      { campaignId: "c_autumn", name: "Autumn sale", priority: 200, status: "ACTIVE", keeps: 4, yields: 0 },
    ]);
  });

  it("finds nothing when no other campaign covers these variants", () => {
    expect(overlapsFrom([cover("draft", 5, 5)], "draft", OTHERS)).toEqual([]);
  });

  it("drops a campaign that covers variants but neither keeps nor yields any to this one", () => {
    // It lost them to a third campaign: no statement about this one to make.
    expect(overlapsFrom([cover("c_clear", 3, 0, { c_autumn: 3 })], "draft", OTHERS)).toEqual([]);
  });

  it("names a campaign it was not handed rather than dropping it", () => {
    expect(overlapsFrom([cover("c_ghost", 2, 2)], "draft", OTHERS)[0]).toMatchObject({ name: "Another campaign", keeps: 2 });
  });

  it("on a revert, where this campaign is out of the plan, lists who keeps the variants", () => {
    const found = overlapsFrom([cover("c_autumn", 57, 57)], "reverting", OTHERS);
    expect(found).toEqual([expect.objectContaining({ campaignId: "c_autumn", keeps: 57, yields: 0 })]);
  });
});

describe("the sentences the Apply dialog shows", () => {
  it("says who keeps what and who gives what up, with a held campaign said as held", () => {
    expect(
      overlapSentences([
        { campaignId: "c_autumn", name: "Autumn sale", priority: 200, status: "ACTIVE", keeps: 1_240, yields: 0 },
        { campaignId: "c_clear", name: "Clearance", priority: 50, status: "HELD", keeps: 0, yields: 1 },
      ]),
    ).toEqual([
      "Autumn sale keeps 1,240 variants; it outranks this campaign.",
      "This campaign takes 1 variant from Clearance (held for a hand edit); reverting it hands them back.",
    ]);
  });
});
