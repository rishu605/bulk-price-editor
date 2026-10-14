/**
 * Which campaigns share a campaign's variants, and who prices them (#821).
 *
 * Read off the planner's coverage, the resolver's answer for every candidate. It used to
 * be read off the planned rows, which leave out a variant already at its price: exactly
 * the variant another campaign keeps. A sale entirely under a higher-priority one then
 * found no overlap at all.
 */

import { describe, expect, it } from "vitest";

import { alreadyCorrectBy, alreadyCorrectFacts, outrankedBy, overlapSentences, overlapsFrom } from "./overlaps";
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

describe("who prices the variants already at their price (#837)", () => {
  /**
   * The live repro: "QA 687 high" (priority 200) priced the probe, then "QA 687 low" was
   * applied under it. Its Apply dialog said "Already correct 1 — no write needed, still owned
   * by this campaign", about a variant the high sale was pricing.
   */
  let n = 0;
  const at = (campaignId?: string) => ({
    ref: { variantGid: `gid/${n++}`, surfaceKind: "base" as const, priceListGid: "", currency: "USD" },
    campaignId,
  });

  it("splits them by the resolver's winner: this campaign, another by name, or nobody", () => {
    const already = alreadyCorrectBy(
      [at("draft"), at("draft"), at("c_autumn"), at("c_clear"), at("c_autumn"), at(undefined)],
      "draft",
      OTHERS,
    );

    expect(already).toEqual({
      own: 2,
      unpriced: 1,
      others: [
        { campaignId: "c_autumn", name: "Autumn sale", status: "ACTIVE", variants: 2 },
        { campaignId: "c_clear", name: "Clearance", status: "HELD", variants: 1 },
      ],
    });
  });

  it("never calls another campaign's variant this campaign's", () => {
    const facts = alreadyCorrectFacts(1, alreadyCorrectBy([at("c_autumn")], "draft", OTHERS));
    const said = facts.map((fact) => `${fact.label}: ${fact.text}`).join(" | ");

    expect(said).not.toContain("this campaign's price");
    expect(said).not.toContain("owned by this campaign");
    expect(said).toContain("1 variant priced by Autumn sale until it ends");
  });

  it("says the ones at this campaign's price are, under their own label", () => {
    const facts = alreadyCorrectFacts(3, alreadyCorrectBy([at("draft"), at("draft"), at("c_clear")], "draft", OTHERS));

    expect(facts).toEqual([
      { label: "Already correct", text: "2 variants already at this campaign's price — no write needed" },
      {
        label: "Priced by another campaign",
        text: "1 variant priced by Clearance (held for a hand edit) until it ends, so nothing is written for it.",
      },
    ]);
  });

  it("claims no owner at all for a preview made without the split", () => {
    expect(alreadyCorrectFacts(4, undefined)).toEqual([{ label: "Already correct", text: "4 — no write needed" }]);
    expect(alreadyCorrectFacts(0, undefined)).toEqual([]);
  });
});

describe("a campaign that prices none of what it covers (#837)", () => {
  it("names the campaigns pricing every variant it covers", () => {
    expect(outrankedBy([cover("low", 3, 0, { c_autumn: 2, c_clear: 1 })], "low", OTHERS)).toEqual(["Autumn sale", "Clearance"]);
  });

  it("names nobody once it prices even one", () => {
    expect(outrankedBy([cover("low", 3, 1, { c_autumn: 2 })], "low", OTHERS)).toEqual([]);
  });

  it("names nobody when some of what it covers is priced by no campaign at all", () => {
    // A rule row that matches none of them: the storefront shows no campaign's price there.
    expect(outrankedBy([cover("low", 3, 0, { c_autumn: 2 })], "low", OTHERS)).toEqual([]);
  });

  it("names nobody for a campaign with nothing in scope", () => {
    expect(outrankedBy([], "low", OTHERS)).toEqual([]);
    expect(outrankedBy([cover("low", 0, 0)], "low", OTHERS)).toEqual([]);
  });
});
