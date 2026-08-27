/**
 * Form controls are sized to what they hold.
 *
 * A Polaris field in a block stack takes the full width of its card whatever it
 * contains, so a "Vendor" select holding one word rendered twelve hundred pixels wide —
 * and three of them stacked read as three grey bars.
 *
 * It is not a width problem. The page is exactly as wide as it should be; the control
 * does not know how much room it needs, and widening the page makes it worse. Fields
 * carry no width prop, so the fix is layout, and this pins the two ways it silently
 * reverts: the comma trap, and a checkbox left in a column.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const grid = readFileSync(join(process.cwd(), "app", "components", "FieldGrid.tsx"), "utf8");
const settings = readFileSync(
  join(process.cwd(), "app", "routes", "app.settings._index.tsx"),
  "utf8",
);
const editor = readFileSync(
  join(process.cwd(), "app", "routes", "app.campaigns.new.tsx"),
  "utf8",
);

describe("the field grid", () => {
  it("carries exactly one comma, so the value parses", () => {
    // `repeat(2, 1fr)` is the obvious way to write it and is unparseable: Polaris splits
    // a responsive value on the comma, so the whole thing falls back to `none` and every
    // field goes full width again — which looks exactly like the bug being fixed.
    const value = /gridTemplateColumns="([^"]+)"/.exec(grid)?.[1] ?? "";
    expect(value.split(",").length - 1, `"${value}" has a comma inside a value`).toBe(1);
    expect(value).not.toContain("repeat(");
  });

  it("collapses to one column on a narrow container", () => {
    expect(grid).toMatch(/inline-size <= 700px/);
  });

  it("offers a full-row escape hatch", () => {
    // A checkbox is a tick and a sentence, not a field. In a column sized for a select
    // its label wraps under the box.
    expect(grid).toContain('gridColumn="span 2"');
  });
});

describe("the two longest forms use it", () => {
  it.each([
    ["settings", settings],
    ["the campaign editor", editor],
  ])("%s lays its fields out in the grid", (_name, source) => {
    expect(source).toContain("<FieldGrid>");
  });

  it("gives the guardrail checkbox its own row", () => {
    const block = settings.slice(settings.indexOf("<FieldGrid>"));
    const checkbox = block.indexOf("neverBelowCost");
    const fullRow = block.indexOf("<FullRow>");
    expect(fullRow, "the checkbox is not wrapped").toBeGreaterThanOrEqual(0);
    expect(fullRow).toBeLessThan(checkbox);
  });
});
