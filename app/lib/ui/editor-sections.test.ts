/**
 * The order a merchant is asked things in, and where the button that ends it sits.
 *
 * The editor had two numbered sections for nine subjects. "1 · Rule" held the name, the
 * rule, compare-at, rounding, the markets checkboxes, a rounding select per currency, the
 * schedule and four "Advanced (optional)" controls; "2 · Scope" held the ninth. The two
 * things a merchant actually has to decide were the first and the last of them.
 *
 * And the submit was inside section 1, above the heading of section 2 — so "Create and
 * preview", the obvious button on the page, was reachable before the merchant had read
 * the section that decides which products the rule applies to. Nothing warned them; the
 * campaign was simply created against the whole catalogue.
 *
 * `docs/competitors/na-bulk-price-editor.md` records the shape that works and it is this
 * one: a few numbered sections on one page, an "Advanced (optional)" bucket last, one
 * submit under all of it.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const editor = sourceOf(process.cwd(), "app", "routes", "app.campaigns.new.tsx");

/** Where each numbered section's card opens, in source order. */
function sectionAt(key: string): number {
  return editor.indexOf(`<Card heading={headings.${key}}>`);
}

const SECTIONS = ["rule", "scope", "when", "markets", "advanced"];

describe("the form's sections", () => {
  it("asks about more than the rule and the scope", () => {
    // Two sections for nine subjects is the state this replaced.
    for (const key of SECTIONS) {
      expect(sectionAt(key), `no card for headings.${key}`).toBeGreaterThan(-1);
    }
  });

  it("puts them in the order the questions are asked", () => {
    const positions = SECTIONS.map(sectionAt);
    const sorted = [...positions].sort((a, b) => a - b);

    expect(positions, "the cards are not in the order they are numbered").toEqual(sorted);
  });

  it("numbers only the sections this shop can answer", () => {
    // A store with no price lists has no markets card, and the numbering has to close
    // over the gap rather than skip a number.
    const start = editor.indexOf("numberSections([");
    const spec = editor.slice(start, editor.indexOf("]);", start));

    expect(spec).toContain("priceLists.length > 0");
    expect(spec).toContain('key: "advanced"');
  });
});

describe("the submit", () => {
  it("comes after every section it submits", () => {
    const submit = editor.indexOf('<s-button type="submit" variant="primary">');

    expect(submit).toBeGreaterThan(-1);
    for (const key of SECTIONS) {
      expect(
        submit,
        `the submit is above the "${key}" section, so a merchant can press it without reading that section`,
      ).toBeGreaterThan(sectionAt(key));
    }
  });

  it("is not inside a card", () => {
    // Inside one it reads as that section's action rather than as the form's. Matched on
    // `Card` rather than `s-section` since #578 — every titled section in the main column
    // is one, and the section element is now an implementation detail of that component.
    const submit = editor.indexOf('<s-button type="submit" variant="primary">');
    const lastOpen = editor.lastIndexOf("<Card", submit);
    const lastClose = editor.lastIndexOf("</Card>", submit);

    expect(lastClose).toBeGreaterThan(lastOpen);
  });
});

describe("what the spreadsheet path still does not render", () => {
  it("shows no scope, schedule or advanced settings for a file", () => {
    // A file names its own variants and creates its campaign through its own two-phase
    // dry-run flow, so a schedule or a priority set here would be silently discarded —
    // which is the confusion having two pages caused in the first place.
    for (const key of ["scope", "when", "advanced"]) {
      const card = sectionAt(key);
      const guard = editor.lastIndexOf("fromFile", card);

      expect(guard, `the ${key} section is not behind a fromFile check`).toBeGreaterThan(-1);
      expect(editor.slice(guard, card)).toMatch(/^fromFile[\s\S]{0,40}$/);
    }
  });
});
