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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const search = readFileSync(
  join(process.cwd(), "app", "components", "prices", "VariantSearch.tsx"),
  "utf8",
);

describe("the filter block", () => {
  it("lays its controls out in a grid, not a stretching stack", () => {
    expect(search).toContain("<s-grid");
    expect(search).toContain("<s-grid-item");
  });

  it("re-flows to one column on a narrow container", () => {
    expect(search).toMatch(/@container[^"]*inline-size <= 700px/);
  });

  it("carries exactly one comma, so the value parses", () => {
    // `repeat(3, 1fr)` is the obvious way to write three columns and it is unparseable:
    // Polaris splits a responsive value on the comma to separate the two branches, so
    // the value falls back to `none` and every control goes full width again — which
    // looks exactly like the bug this fixes.
    const value = /gridTemplateColumns="([^"]+)"/.exec(search)?.[1] ?? "";
    expect(value.split(",").length - 1, `"${value}" has a comma inside a value`).toBe(1);
    expect(value).not.toContain("repeat(");
  });

  it("keeps the submit button at its natural width", () => {
    // A block stack stretches its children, which rendered the button as a full-width
    // bar across the card.
    const afterGrid = search.slice(search.indexOf("</s-grid>"));
    expect(afterGrid).toContain('direction="inline"');
    expect(afterGrid).toContain("Search");
  });
});
