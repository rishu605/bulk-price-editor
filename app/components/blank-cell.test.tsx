/**
 * A missing value is not content, and should not look like it.
 *
 * Every table here writes `—` where a row has no SKU, no cost, no compare-at. At full text
 * weight that dash has exactly the visual weight of the prices beside it, so a store with
 * no SKUs renders a column of forty identical dashes that the eye keeps stopping on — and
 * on the catalogue, three of seven columns can look like that at once.
 *
 * Forty-four of them were written as the bare string. One component now, so "nothing here"
 * is styled in one place rather than in whichever table somebody is editing.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Blank } from "./Blank";
import { sourceFiles, sourceOf } from "../lib/testing/source";

describe("Blank", () => {
  const html = renderToStaticMarkup(<Blank />);

  it("is an em dash, so a gap is distinguishable from a broken page", () => {
    // Not an empty cell: a merchant cannot tell a missing value from a render that
    // failed. Not a word either — "None" in every gap is more noise than the dash.
    expect(html).toContain("—");
  });

  it("is subdued, so a column of them reads as empty", () => {
    expect(html).toContain('color="subdued"');
  });

  it("carries no status tone", () => {
    // De-emphasis, not a signal. A `tone` here would put it under the WCAG rule in
    // `colour-signal.test.ts`, which is about meanings carried by colour alone —
    // "there is nothing here" is not one of those.
    expect(html).not.toMatch(/tone="(critical|success|warning|caution|info)"/);
  });
});

describe("no table writes the dash itself", () => {
  /**
   * Prose, where a subdued dash inside a sentence would be worse than a plain one.
   *
   * `StorefrontExample` renders "was 40.00, becomes 32.00" as a shopper would see it, and
   * the after-price is deliberately `type="strong"` — a subdued em dash inside a strong
   * price is two weights fighting in one span.
   */
  const NOT_A_CELL: Record<string, string> = {
    "app/components/StorefrontExample.tsx": "prose, not a table cell",
  };

  it("uses the component everywhere a cell can be empty", () => {
    const offenders = sourceFiles("app/routes", "app/components")
      .filter((file) => !(file in NOT_A_CELL))
      .filter((file) => sourceOf(file).includes('"—"'));

    expect(offenders, "render <Blank /> rather than the string").toEqual([]);
  });

  it("finds the tables it is protecting", () => {
    // A floor, so this cannot pass by finding nothing — the failure mode of every census
    // check in this repo.
    const users = sourceFiles("app/routes", "app/components").filter((file) =>
      sourceOf(file).includes("<Blank />"),
    );

    expect(users.length).toBeGreaterThanOrEqual(12);
  });
});
