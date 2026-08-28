/**
 * The campaign editor's fields are laid out, not stacked.
 *
 * `FieldGrid` was written for this exact failure and its doc comment names it: a "Vendor"
 * select holding one word rendered as a twelve-hundred-pixel bar, and three of them
 * stacked is "the single most unstyled-looking thing in this app". Step 1 · Scope used it.
 * Step 2 · Rule — the longer form, and the one a merchant actually fills in — was a plain
 * `s-stack` of roughly fifteen full-width controls.
 *
 * This is a source check rather than a render because the editor is a route: it reads a
 * loader, a fetcher and `useState` inside `RuleValueField`. What can be checked without
 * a browser is the structure — which is what was wrong — and the two things about that
 * structure that are silently breakable:
 *
 * - `RuleValueField` renders *two* fields as a fragment, so it must not be wrapped in a
 *   `FullRow`, or both land in one cell and stack;
 * - the rarely-touched four are below the schedule and named optional, not sitting
 *   between the rule and the thing the merchant came to set.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const EDITOR = readFileSync(join(process.cwd(), "app/routes/app.campaigns.new.tsx"), "utf8");

/** Where a name first appears in the file, or -1. Source order is render order here. */
const at = (needle: string) => EDITOR.indexOf(needle);

describe("step 2 lays its fields out in columns", () => {
  it("uses the grid the page's own step 1 already uses", () => {
    // Three: the rule, the per-currency rounding, and the schedule. Plus advanced.
    expect((EDITOR.match(/<FieldGrid>/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("no longer stacks the whole form in one block", () => {
    // `s-stack gap="base"` around fifteen fields is what made the column of bars. The
    // stack is still there — it separates the named blocks — but it takes its rhythm
    // from the scale and its children are grids.
    expect(EDITOR).not.toContain('<s-stack gap="base">');
  });

  it("pairs the adjustment with its amount instead of wrapping both in one cell", () => {
    const rule = at("<RuleValueField");
    const before = EDITOR.slice(Math.max(0, rule - 200), rule);

    expect(before).not.toMatch(/<FullRow>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?$/);
  });

  it("keeps the checkbox and the tag sentence on rows of their own", () => {
    // A checkbox is a tick and a sentence, not a field: a column sized for a select
    // leaves it stranded with its label wrapping under the box.
    const advanced = EDITOR.slice(at("Advanced (optional)"));

    expect(advanced).toMatch(/<FullRow>\s*<s-text-field\s+name="tagKit"/);
    expect(advanced).toMatch(/<FullRow>\s*<s-checkbox\s+name="autoEnroll"/);
  });
});

describe("the rule is what a merchant meets first", () => {
  it("previews the rule directly under the rule", () => {
    expect(at("<RuleValueField")).toBeLessThan(at("What this would do"));
    expect(at("What this would do")).toBeLessThan(at("Markets and catalogues"));
  });

  it("puts the four rarely-touched settings after the schedule, not before it", () => {
    for (const field of ['name="priority"', 'name="tagKit"', 'name="autoEnroll"', 'name="revertBuffer"']) {
      expect(at(field), `${field} is above the schedule`).toBeGreaterThan(at("Schedule (optional)"));
      expect(at(field), `${field} is outside the advanced block`).toBeGreaterThan(
        at("Advanced (optional)"),
      );
    }
  });

  it("says the advanced block can be skipped", () => {
    expect(EDITOR).toContain("Advanced (optional)");
    expect(EDITOR).toMatch(/Skip them\s*\n?\s*unless you have a reason/);
  });

  it("still submits after everything, exactly once", () => {
    expect((EDITOR.match(/type="submit"/g) ?? []).length).toBe(2); // scope's, and the create
    expect(at("Create and preview")).toBeGreaterThan(at("Advanced (optional)"));
  });
});

describe("no stack is wrapped around a single child", () => {
  it("finds none in the editor", () => {
    // Two of these: one round the scope form's submit, one round each schedule pair.
    // A stack with one child lays nothing out; it is the shape left behind when the
    // other children were moved somewhere else.
    const singles = [
      ...EDITOR.matchAll(/<s-stack[^>]*>\s*<([a-zA-Z-]+)[^>]*>[^<]*<\/\1>\s*<\/s-stack>/g),
    ];

    expect(singles.map((match) => match[1])).toEqual([]);
  });
});
