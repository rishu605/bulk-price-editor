/**
 * The stylesheet survives the trip to the browser.
 *
 * This is not a taste assertion. React escapes text inside a `<style>` element, and the
 * help centre's sheet was rendered as a text child for as long as it existed — so every
 * declaration containing a quote reached the browser as `&quot;…&quot;` and was dropped
 * on the floor. The page had no font stack; it rendered in the browser's default serif.
 * The search field had no border, whose contrast a WCAG test in `compliance/` was
 * meanwhile computing and passing, because that test reads the source and not the page.
 *
 * That is the shape of bug worth a test: one where the thing asserting correctness and
 * the thing rendering to a merchant were looking at different strings.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HELP_STYLES, HelpStyles } from "./styles";

describe("the sheet the browser receives", () => {
  it("is the sheet we wrote, character for character", () => {
    const markup = renderToStaticMarkup(HelpStyles());

    expect(markup).toBe(`<style>${HELP_STYLES}</style>`);
  });

  it("would not be, rendered the obvious way — which is how this got shipped", () => {
    // The hazard, demonstrated rather than described. If React ever stops escaping here
    // this test fails, and the guard above becomes unnecessary rather than wrong.
    const escaped = renderToStaticMarkup(createElement("style", null, HELP_STYLES));

    expect(escaped).toContain("&quot;");
    expect(escaped).not.toBe(`<style>${HELP_STYLES}</style>`);
  });

  it("has no quotes it could lose without anyone noticing", () => {
    // Belt as well as braces: the declarations that were dropped are named here, so a
    // future rewrite that reintroduces the escaping fails on something a reader can see
    // rather than on a diff of two large strings.
    expect(HELP_STYLES).toContain('"Segoe UI"');
    expect(HELP_STYLES).toContain('[data-tone="0"]');
    expect(HELP_STYLES).toContain('a[aria-current="page"]');
  });

  /**
   * The sheet is a template literal. A backtick inside it — in a comment explaining a
   * property, most temptingly — ends the string early, and the failure is a build error
   * pointing at CSS rather than at the sentence that caused it.
   */
  it("contains no backtick, which would end the literal it lives in", () => {
    expect(HELP_STYLES).not.toContain("`");
  });
});
