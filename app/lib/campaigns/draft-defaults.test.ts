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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { DRAFT_DEFAULTS, draftDefaultParams } from "./draft-defaults";


const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");

const ROUTES = readdirSync(join(process.cwd(), "app", "routes"))
  .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
  .map((name) => ({ name, source: sourceOf(join("app", "routes", name)) }));
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

  it("asks for the preview from the client, once, on mount", () => {
    // Not from the loader. `previewDraft` loads every candidate in scope and plans all
    // of them, because the counts are exact — in front of first paint that is a minute
    // of blank page on a catalogue of any size (#468), and blank has nowhere to put a
    // spinner.
    expect(EDITOR).toContain("previewFetcher.state");
    expect(EDITOR).toMatch(/useEffect\(\(\) => \{[\s\S]*?previewFetcher\.submit/);
  });

  it("builds that first request rather than reading a form that is not ready", () => {
    // Serialising the fields at mount described a scope that matched nothing where an
    // empty filter matches everything (#470). Only later requests read the form.
    expect(EDITOR).toContain("firstPreviewParams(");
    expect(EDITOR).toMatch(/useEffect\(\(\) => \{[\s\S]*?new URLSearchParams\(firstPreview\)/);
    expect(
      EDITOR,
      "the mount request is reading the form again, which is where #470 came from",
    ).not.toMatch(/useEffect\(\(\) => \{[\s\S]*?submitPreview\(\)[\s\S]*?\}, \[\]\)/);
  });
});

describe("no loader prices a draft before the page paints", () => {
  it("finds routes to check, so this cannot pass by checking nothing", () => {
    expect(ROUTES.length).toBeGreaterThan(15);
  });

  /**
   * Routes that may price a draft in a loader, and why.
   *
   * #468 is the rule: the editor primed its panel server-side and the page took over a
   * minute to paint, blank, on a real catalogue. The rule is about work in front of a
   * *first paint that has something else to show*.
   *
   * The full preview is the exception that proves it. The priced rows are not a panel
   * beside a form — they are the entire page, there is nothing to paint first, and a
   * merchant who followed "see all 3,669 rows" is waiting for exactly this. Doing it from
   * the client would mean a page that renders empty and then fills, which is the same
   * blank screen #468 was about, arrived at from the other direction.
   */
  const MAY_PRICE_IN_A_LOADER: Record<string, string> = {
    "app.preview-draft.tsx": "the resource route the editor posts to; it has no page",
    "app.campaigns.preview.tsx": "the priced rows are the whole page, not a panel beside one",
  };

  it("leaves previewDraft to the resource route the client posts to", () => {
    // Read from the routes directory rather than a list: the temptation to prime the
    // panel server-side will come back, and it will come back on a store small enough
    // for the author not to notice.
    const offenders = ROUTES.filter(
      ({ name, source }) => !(name in MAY_PRICE_IN_A_LOADER) && source.includes("previewDraft("),
    ).map(({ name }) => name);

    expect(
      offenders,
      "a loader that prices the whole scope puts that work in front of first paint",
    ).toEqual([]);
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
