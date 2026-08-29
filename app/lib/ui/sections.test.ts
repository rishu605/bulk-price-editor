/**
 * A numbered form that is not always the same length still counts from one.
 *
 * The failure this prevents is small and unmistakable: a merchant reads "1 · Rule" and
 * then "3 · Schedule", and spends a moment looking for the step they skipped. It arrives
 * the day a section becomes conditional, which is #445 — a campaign priced from a file
 * has no scope to choose.
 */

import { describe, expect, it } from "vitest";

import { numberSections } from "./sections";

const RULE = { key: "rule", title: "Rule" };
const SCOPE = { key: "scope", title: "Scope" };

describe("numbering the sections that apply", () => {
  it("numbers from one, in order", () => {
    expect(numberSections([RULE, SCOPE])).toEqual({
      rule: "1 · Rule",
      scope: "2 · Scope",
    });
  });

  it("closes the numbering up when one does not apply", () => {
    expect(numberSections([RULE, { ...SCOPE, when: false }, { key: "when", title: "When" }])).toEqual(
      { rule: "1 · Rule", when: "2 · When" },
    );
  });

  it("gives an absent section no heading at all, rather than an empty one", () => {
    // A heading of `""` renders a titled card with no title, which looks like a bug in
    // the card rather than a section that was deliberately left out.
    expect(numberSections([{ ...RULE, when: false }])).toEqual({});
  });

  it("treats an omitted `when` as present", () => {
    expect(numberSections([RULE, { ...SCOPE, when: true }])).toEqual({
      rule: "1 · Rule",
      scope: "2 · Scope",
    });
  });

  it("keys by name so the caller never counts", () => {
    const headings = numberSections([SCOPE, RULE]);

    expect(headings.rule, "reordering must not hand a section its neighbour's number").toBe(
      "2 · Rule",
    );
  });
});
