/**
 * Controls are sized to what they hold.
 *
 * Stacked in a block, every Polaris field takes the full width of its card: a "Surface"
 * select holding the word "Every" rendered twelve hundred pixels wide. That is the most
 * unstyled-looking thing in the app, and it is not a width problem — the page is exactly
 * as wide as it should be. It is a control that does not know how much room it needs.
 *
 * Fields have no width prop, so the fix is layout: a grid with named columns rather than
 * a stack that stretches its children.
 */


import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";

const search = sourceOf(process.cwd(), "app", "components", "prices", "VariantSearch.tsx");

describe("the filter block", () => {
  it("lays its controls out in a grid, not a stretching stack", () => {
    expect(search).toContain("<s-grid");
    expect(search).toContain("<s-grid-item");
  });

  it("re-flows to one column on a narrow container", () => {
    expect(search).toMatch(/@container[^"]*inline-size <= 700px/);
  });

  it("carries exactly one comma per responsive value, so it parses", () => {
    // `repeat(3, 1fr)` is the obvious way to write three columns and it is unparseable:
    // Polaris splits a responsive value on the comma to separate the two branches, so
    // the value falls back to `none` and every control goes full width again — which
    // looks exactly like the bug this fixes.
    //
    // Every value in the file, not just the first: the inline branch grew a plain
    // `1fr auto` and a check that only read the first match started asserting about that
    // one instead, which is a test quietly changing what it tests.
    const values = [...search.matchAll(/gridTemplateColumns="([^"]+)"/g)].map((m) => m[1]);
    expect(values.length, "both branches lay out in a grid").toBe(2);

    for (const value of values) {
      const commas = value.split(",").length - 1;
      // One comma separates "when the query matches" from "otherwise"; a value with no
      // query has no branches and so no comma at all.
      expect(commas, `"${value}" has the wrong number of commas`).toBe(
        value.includes("@container") ? 1 : 0,
      );
      expect(value).not.toContain("repeat(");
    }
  });

  it("keeps the submit button at its natural width", () => {
    // A block stack stretches its children, which rendered the button as a full-width
    // bar across the card.
    const afterGrid = search.slice(search.lastIndexOf("</s-grid>"));
    expect(afterGrid).toContain('direction="inline"');
    expect(afterGrid).toContain("Search");
  });

  it("puts the inline search and its button on one line", () => {
    // The field takes every pixel it is offered, so an inline stack left the button
    // nothing and it wrapped underneath — an orphaned control under the field's left
    // edge, which is what the campaigns index looked like before the same fix.
    const inline = search.slice(
      search.indexOf('direction === "inline"'),
      search.indexOf("A grid, not a vertical stack"),
    );
    expect(inline).toContain('gridTemplateColumns="1fr auto"');
    expect(inline, "the hidden label is what lets the two share a line").toContain(
      'labelAccessibilityVisibility="exclusive"',
    );
  });
});
