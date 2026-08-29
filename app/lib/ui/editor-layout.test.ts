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


import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

/**
 * The editor's source with its comments removed.
 *
 * Every assertion here is a grep, and the comments in that file talk about the very
 * things being grepped for — the removed "Update match count" button is named in the
 * comment explaining why it went. A grep that reads its own explanation is the trap this
 * repo has now hit five times. The same two lines appear in `table-size.test.ts` and
 * `imports.test.ts`; extracting them is #462.
 */
const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");

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
  it("opens on the rule and asks for the scope after it", () => {
    // A merchant arrives having decided "20% off boots". The form used to open on boots.
    // Every competitor asks for the change first — NA and RUBIX by name-then-method,
    // Sami by picking the field to edit — because it is the decision that was already
    // made before the page loaded.
    expect(at('headings.rule')).toBeLessThan(at('headings.scope'));
    // `<CampaignNameField`, not `name="name"`. The field moved into a component when it
    // grew a counter, and the spreadsheet path has a `name="name"` of its own further
    // down the file — so matching the attribute now finds the wrong one and would pass
    // or fail for reasons unrelated to the order these sections are in.
    expect(at("<CampaignNameField"), "the campaign's name is below the scope again").toBeLessThan(
      at('name="collection"'),
    );
    expect(at("<RuleValueField")).toBeLessThan(at('name="collection"'));
  });

  it("numbers the headings from what it renders, rather than writing them out", () => {
    // #445 makes the scope conditional — a campaign priced from a file has no scope to
    // choose — and a form that jumps from "1 · Rule" to "3 · Schedule" reads as a step
    // gone missing.
    expect(EDITOR).toContain("numberSections(");
    expect(EDITOR).not.toMatch(/heading="\d+ · /);
  });

  it("prefills the name and says who sees it", () => {
    // Empty and required is a blocker in front of a decision. RUBIX leaves it empty and
    // it is the first thing on their page; NA prefills a timestamp and adds a line
    // saying customers will not see it, which is the question a merchant actually has.
    // The field itself moved into `CampaignNameField` when it grew a counter, so the
    // two halves are checked where they now live: the route still computes the name on
    // the server, and the field still seeds itself from it and still answers the
    // question a merchant actually has.
    expect(EDITOR).toContain("<CampaignNameField defaultName={defaultName} />");
    expect(EDITOR, "a name built during render is a hydration mismatch").toContain(
      "defaultName: `",
    );

    const field = sourceOf("app/components/campaign/CampaignNameField.tsx");
    expect(field).toContain("value={defaultName}");
    expect(field).toMatch(/customers never see it/i);
    // The counter: "how much can I write" is the other question the first field on the
    // page raises, and a static maximum tells somebody already over it nothing.
    //
    // `maxLength` and nothing else. Polaris renders the count itself, and a second one in
    // the help text put the same number on screen twice — which only opening the page
    // showed, because the markup serialises fine either way.
    expect(field).toContain("maxLength={NAME_LIMIT}");
    expect(field, "Polaris already counts; a second counter renders the number twice").not.toMatch(
      /\$\{[^}]*length[^}]*\}\/\$\{NAME_LIMIT\}/,
    );
  });

  it("previews the rule beside it, in the aside, rather than under it", () => {
    // It was directly under the rule, which on a form this long meant off screen while
    // the rule was being typed. The column is where it goes; what has to stay true is
    // that there is exactly one of it and it is not back inside the form.
    expect(EDITOR).toContain('<s-section slot="aside" heading="What this would do">');
    expect((EDITOR.match(/<DraftPreview/g) ?? []).length).toBe(1);
    expect(
      at("<DraftPreview"),
      "the preview is inside the form again, which is where it was off screen",
    ).toBeGreaterThan(at("</Form>"));
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

  it("submits once, after everything", () => {
    // Two, once: the scope had its own GET form with an "Update match count" button, so
    // reading the count meant a navigation that reset every field in the rule form. One
    // form has one submit, and a second appearing here means the scope has been split
    // back out.
    expect((EDITOR.match(/type="submit"/g) ?? []).length).toBe(1);
    expect(EDITOR).not.toContain("Update match count");
    expect(at("Create and preview")).toBeGreaterThan(at("Advanced (optional)"));
  });

  it("scopes and prices from one form, so a filter change reprices", () => {
    // The fetcher posts `new FormData(form)`. With the scope outside that form a filter
    // change could not move the preview, and the scope had to be mirrored in as six
    // hidden inputs that a new field could silently miss.
    expect((EDITOR.match(/<Form /g) ?? []).length).toBe(1);
    expect(
      EDITOR,
      "a hidden mirror of a scope field means there are two forms again",
    ).not.toMatch(/<input type="hidden" name="(collection|tag|vendor|title|segment)"/);

    for (const field of ['name="segment"', 'name="collection"', 'name="tag"', 'name="vendor"', 'name="title"']) {
      expect(at(field), `${field} is outside the form that prices it`).toBeGreaterThan(at("<Form "));
      expect(at(field), `${field} is outside the form that submits it`).toBeLessThan(at("</Form>"));
    }
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
