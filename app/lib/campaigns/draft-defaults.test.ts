/**
 * The unedited form and the preview of it say the same thing.
 *
 * The campaign editor's preview is now primed by the loader, so the panel arrives
 * populated instead of saying "set a rule" next to a rule that is already set. That
 * means two things read the same defaults: the fields, which render them, and the
 * loader, which prices them without a form to read.
 *
 * A merchant cannot see this drift the way a broken layout is visible. They see a
 * sidebar predicting −20% beside a field that says −25%, or a preview computed with no
 * rounding beside a select that says `.99` — a preview that is wrong in exactly the way
 * rule 4 exists to prevent, and wrong quietly.
 *
 * So: the values live in one object, and this refuses a literal of them anywhere else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DRAFT_DEFAULTS, draftDefaultParams } from "./draft-defaults";

/** Source with comments removed — they discuss the very literals being grepped for. */
const sourceOf = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
const RULE_FIELD = sourceOf("app/components/RuleValueField.tsx");

describe("the defaults are a value, not a literal in two files", () => {
  it("renders the rule fields from the shared object", () => {
    expect(RULE_FIELD).toContain("DRAFT_DEFAULTS");

    for (const literal of ['"percent-change"', '"-20"', '"-10"']) {
      expect(
        RULE_FIELD,
        `${literal} is written out in the field as well as in DRAFT_DEFAULTS, so the ` +
          "loader's preview and the form can now disagree",
      ).not.toContain(literal);
    }
  });

  it("primes the loader's preview from the same object", () => {
    expect(EDITOR).toContain("draftDefaultParams()");
    expect(EDITOR).toContain("previewDraft(");
  });

  it("seeds the shop's own rounding rather than letting it fall back to none", () => {
    // `readRoundingPolicy` returns "none" when the field is absent, and the select
    // renders the store setting as its chosen option. Seeding nothing means a preview
    // that rounds differently from the form beside it.
    expect(EDITOR).toContain('seeded.set("rounding.default", settings.rounding.default)');
    expect(EDITOR).toMatch(/rounding\.\$\{code\}/);
  });
});

describe("the seeded params are what the form would have sent", () => {
  const params = draftDefaultParams();

  it("carries the rule, its amount, the compare-at policy and the priority", () => {
    expect(params.get("ruleKind")).toBe(DRAFT_DEFAULTS.ruleKind);
    expect(params.get("ruleValue")).toBe(DRAFT_DEFAULTS.percentValue);
    expect(params.get("compareAt")).toBe(DRAFT_DEFAULTS.compareAt);
    expect(params.get("priority")).toBe(DRAFT_DEFAULTS.priority);
  });

  it("carries no rounding of its own", () => {
    // Rounding is the shop's setting, not a default of this module's — a value here
    // would be a rounding rule the merchant never chose, previewed as though they had.
    expect([...params.keys()].filter((key) => key.startsWith("rounding."))).toEqual([]);
  });

  it("defaults the amount to a discount, because that is what a campaign is", () => {
    expect(Number(DRAFT_DEFAULTS.percentValue)).toBeLessThan(0);
    expect(Number(DRAFT_DEFAULTS.fixedValue)).toBeLessThan(0);
  });
});
