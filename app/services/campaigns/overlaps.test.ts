/**
 * Which campaigns this draft meets, counted from the resolver's own answer.
 *
 * The count could be assembled from the scopes — two campaigns whose filters both say
 * "Outerwear" surely meet — and it would be wrong. A third campaign may outrank them both
 * on part of it, so the variants they actually share is a question only `planRun` has
 * answered. Rule 4's reasoning applied one level up: a second implementation of "who owns
 * this variant" is free to disagree with the one that will run.
 */

import { describe, expect, it } from "vitest";

import { overlapsFrom } from "./draft-preview.server";

const OTHERS = [
  { id: "c_autumn", name: "Autumn sale", priority: 200 },
  { id: "c_clear", name: "Clearance", priority: 150 },
];

const rows = (...ids: Array<string | undefined>) => ids.map((campaignId) => ({ campaignId }));

describe("counting from planned rows", () => {
  it("does not take the draft's priority, because it does not decide anything", () => {
    // `keepsThem` is read off the rows the resolver produced. Recomputing "who should
    // win" from the priorities here would be a second implementation of the resolver,
    // free to disagree with the one that will run — and the unused parameter that said
    // otherwise is what turned main red (#478).
    expect(overlapsFrom.length).toBe(2);
  });

  it("counts only rows the draft did not win", () => {
    const found = overlapsFrom(rows("draft", "c_autumn", "c_autumn", "draft"), OTHERS);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ campaignId: "c_autumn", name: "Autumn sale", variants: 2 });
  });

  it("finds nothing when the draft won everything", () => {
    // The ordinary case, and the one that must render silence.
    expect(overlapsFrom(rows("draft", "draft"), OTHERS)).toEqual([]);
  });

  it("ignores rows with no campaign at all", () => {
    // A skipped row can carry no owner; counting it as an overlap invents a conflict.
    expect(overlapsFrom(rows(undefined, "draft"), OTHERS)).toEqual([]);
  });

  it("puts the biggest overlap first, because that is the one to decide about", () => {
    const found = overlapsFrom(rows("c_clear", "c_autumn", "c_autumn", "c_autumn"), OTHERS);

    expect(found.map((overlap) => overlap.campaignId)).toEqual(["c_autumn", "c_clear"]);
  });

  it("carries each campaign's priority, so the panel can say what to change", () => {
    expect(overlapsFrom(rows("c_clear"), OTHERS)[0].priority).toBe(150);
  });
});

describe("a campaign the caller did not hand us", () => {
  it("is still reported, without inventing a name", () => {
    // Better a nameless overlap than a silently dropped one: the merchant is about to be
    // told a count, and a count that quietly omits a campaign is the wrong count.
    const found = overlapsFrom(rows("c_ghost"), OTHERS);

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Another campaign");
  });
});
