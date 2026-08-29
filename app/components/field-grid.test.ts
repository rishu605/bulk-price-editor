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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

const grid = sourceOf(process.cwd(), "app", "components", "FieldGrid.tsx");
const settings = sourceOf(process.cwd(), "app", "routes", "app.settings._index.tsx");
const editor = sourceOf(process.cwd(), "app", "routes", "app.campaigns.new.tsx");

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


describe("a single control is sized the same way", () => {
  /**
   * The grid solved this for pages that had several fields to lay out, and every page
   * with *one* field kept the bug. Diagnostics asked for a thirteen-character reference
   * in a 970px box; Feedback offered three short options in a select the width of the
   * screen; Segments named a segment in one. Since the app went full width, "the field
   * fills its card" means something much worse than it used to.
   */
  it("names its widths after content, so a caller answers the right question", () => {
    expect(grid).toMatch(/short:\s*"\d+px"/);
    expect(grid).toMatch(/medium:\s*"\d+px"/);
    expect(grid).toMatch(/long:\s*"\d+px"/);
  });

  it("caps the grid too, because two columns of a wide card are still too wide", () => {
    expect(grid).toMatch(/maxInlineSize="\d+px"/);
  });

  it("gives a single field a definite width, not a ceiling", () => {
    // `maxInlineSize` alone shipped once and was wrong in the one place it mattered most:
    // inside an inline stack a box with only a maximum shrinks to its content, so
    // Diagnostics' empty reference field rendered 68px wide next to its button. A width
    // plus `100%` sizes the field and still lets it shrink on a narrow container.
    const field = grid.slice(grid.indexOf("export function Field"));

    expect(field).toMatch(/inlineSize=\{FIELD\[width\]\}/);
    expect(field, "without this it overflows a narrow card instead of shrinking").toContain(
      'maxInlineSize="100%"',
    );
  });
});

describe("no settings tab leaves a control unbounded", () => {
  /**
   * The rule, checked rather than remembered: a field on a settings page is inside a
   * `Field` or a `FieldGrid`. Checkboxes and choice lists are exempt — they are a tick
   * and a sentence, so they take the room their text needs and a cap would wrap the
   * label under the box.
   *
   * Read from the routes directory rather than a list, so the sixth settings tab is
   * covered without anyone remembering this file exists.
   */
  const ROUTES = join(process.cwd(), "app", "routes");
  const TABS: Array<[name: string, path: string]> = [
    ...readdirSync(ROUTES)
      .filter((name) => name.startsWith("app.settings") && name.endsWith(".tsx"))
      .map((name) => [name, join(ROUTES, name)] as [string, string]),
    // The Feedback tab renders no field of its own -- they are all in this shared form,
    // so scanning only the routes would report that tab clean without looking at it.
    ["FeedbackForm.tsx", join(process.cwd(), "app", "components", "FeedbackForm.tsx")],
  ];

  /** Fields that hold typed or chosen values, and therefore have a natural width. */
  const BOUNDED = /<s-(text-field|select|number-field|money-field|text-area|search-field|email-field)\b/g;

  it("finds the tabs, so this cannot pass by checking nothing", () => {
    expect(TABS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(TABS)("%s", (name, path) => {
    const source = sourceOf(path);

    /** How many of these are open at this point in the file. */
    const depth = (tag: string, upTo: number) => {
      const before = source.slice(0, upTo);
      const open = before.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
      const close = before.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      return open - close;
    };

    const unbounded = [...source.matchAll(BOUNDED)].filter(
      (match) => depth("Field", match.index!) === 0 && depth("FieldGrid", match.index!) === 0,
    );

    expect(
      unbounded.map((m) => m[0]),
      `${name} renders a field with no width — it will fill the card, whatever it holds`,
    ).toEqual([]);
  });
});
