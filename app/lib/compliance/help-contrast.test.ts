/**
 * The help centre's own stylesheet, against WCAG AA.
 *
 * Polaris renders most of this app and its contrast is Shopify's problem. The help centre
 * is not: it ships its own CSS deliberately, because it is the page a merchant reaches
 * when something else has already gone wrong and one fewer asset to fetch is one fewer
 * thing to fail. That makes these colours ours to get right, in both palettes.
 *
 * Computed from the stylesheet as shipped rather than from a list kept beside it — a list
 * agrees with itself no matter what the page actually renders.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AA_LARGE, AA_NORMAL, contrastRatio } from "./contrast";

const source = readFileSync(join(process.cwd(), "app/routes/help.$.tsx"), "utf8");

/** The declaration blocks, split at the dark-mode media query. */
const [lightCss, darkCss] = (() => {
  const at = source.indexOf("@media (prefers-color-scheme: dark)");
  expect(at, "the stylesheet no longer has a dark palette").toBeGreaterThan(-1);
  return [source.slice(0, at), source.slice(at)];
})();

/** The value of a property inside a given selector, as the stylesheet declares it. */
function declared(css: string, selector: string, property: string): string {
  const block = new RegExp(`${selector.replace(/[.[\]"]/g, "\\$&")}[^{]*\\{([^}]*)\\}`).exec(css);
  expect(block, `${selector} is not in the stylesheet`).not.toBeNull();

  const value = new RegExp(`${property}:\\s*([^;]+)`).exec(block![1]);
  expect(value, `${selector} does not set ${property}`).not.toBeNull();

  const hex = /#[0-9a-f]{3,6}/i.exec(value![1]);
  expect(hex, `${selector}'s ${property} is not a hex colour`).not.toBeNull();
  return hex![0];
}

describe("light palette meets AA", () => {
  const page = "#ffffff";

  it.each([
    [".help", "color", AA_NORMAL, "body text"],
    [".help a", "color", AA_NORMAL, "links"],
  ])("%s %s", (selector, property, threshold, what) => {
    const ratio = contrastRatio(declared(lightCss, selector, property), page);

    expect(ratio, `${what} is ${ratio.toFixed(2)}:1 against the page`).toBeGreaterThanOrEqual(
      threshold,
    );
  });

  it("gives form controls a boundary people can see", () => {
    // WCAG 1.4.11. This started at 1.66:1 — visible to most people, invisible to some,
    // and the sort of thing that is only ever found by computing it.
    const border = declared(lightCss, '.help input[type="search"], .help button', "border");
    const ratio = contrastRatio(border, page);

    expect(ratio, `the search field's border is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_LARGE,
    );
  });

  it("keeps highlighted text readable inside the highlight", () => {
    // A search result's `<mark>` is the one place text sits on a colour chosen for
    // attention rather than for contrast.
    const ratio = contrastRatio(declared(lightCss, ".help mark", "background"), "#1a1a1a");

    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("dark palette meets AA", () => {
  const page = "#1a1a1a";

  it("body text", () => {
    expect(contrastRatio(declared(darkCss, ".help", "color"), page)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("links", () => {
    expect(contrastRatio(declared(darkCss, ".help a", "color"), page)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("muted text, which is where a dark palette usually fails", () => {
    const ratio = contrastRatio(declared(darkCss, ".help ol.hits p", "color"), page);

    expect(ratio, `muted text is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("form control boundaries", () => {
    const border = declared(darkCss, '.help input[type="search"], .help button', "border-color");

    expect(contrastRatio(border, page)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("highlighted text inside the highlight", () => {
    const mark = /\.help mark \{ background: (#[0-9a-f]{6}); color: (#[0-9a-f]{6})/i.exec(darkCss);
    expect(mark, "the dark palette no longer sets both mark colours").not.toBeNull();

    expect(contrastRatio(mark![1]!, mark![2]!)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
