/**
 * The help centre's own stylesheet, against WCAG AA.
 *
 * Polaris renders most of this app and its contrast is Shopify's problem. The help centre
 * is not: it ships its own CSS deliberately, because it is the page a merchant reaches
 * when something else has already gone wrong and one fewer asset to fetch is one fewer
 * thing to fail. That makes these colours ours to get right, in both palettes.
 *
 * Computed from the stylesheet as shipped rather than from a list kept beside it — a list
 * agrees with itself no matter what the page actually renders. The sheet declares every
 * colour as a custom property in exactly two places, so what is read here is what the
 * browser resolves; a hard-coded hex anywhere else would be invisible to this file, which
 * is why `every colour is a token` below refuses one.
 */

import { describe, expect, it } from "vitest";

import { HELP_STYLES } from "../help/styles";

import { AA_LARGE, AA_NORMAL, contrastRatio } from "./contrast";

/** The palette blocks, split at the dark-mode media query. */
const [light, dark] = (() => {
  const at = HELP_STYLES.indexOf("@media (prefers-color-scheme: dark)");
  expect(at, "the stylesheet no longer has a dark palette").toBeGreaterThan(-1);

  return [tokensIn(HELP_STYLES.slice(0, at)), tokensIn(HELP_STYLES.slice(at))];
})();

/** Every `--name: #hex` in a stretch of CSS. */
function tokensIn(css: string): Record<string, string> {
  const found: Record<string, string> = {};

  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)) {
    found[name] = value;
  }

  return found;
}

function colour(palette: Record<string, string>, token: string): string {
  const value = palette[token];
  expect(value, `${token} is not declared in the stylesheet`).toBeDefined();
  return value!;
}

/**
 * Every ratio a reader depends on, against one palette.
 *
 * Two named `describe` blocks call this rather than one `describe.each`, because the
 * pre-audit sheet in `docs/built-for-shopify.md` cites these suites by name as the
 * evidence for WCAG 1.4.3 and 1.4.11, and a citation has to name something that exists.
 */
function assertPaletteMeetsAA(palette: Record<string, string>) {
  const on = (token: string, background: string) =>
    contrastRatio(colour(palette, token), colour(palette, background));

  it.each([
    ["--ink", "--paper", AA_NORMAL, "body text"],
    ["--ink", "--surface", AA_NORMAL, "body text on a card"],
    ["--muted", "--paper", AA_NORMAL, "the muted text a lede and every blurb is set in"],
    ["--muted", "--surface", AA_NORMAL, "muted text on a card, where a dark palette usually fails"],
    ["--accent", "--paper", AA_NORMAL, "links"],
    ["--accent", "--surface", AA_NORMAL, "links on a card"],
  ])("%s on %s", (token, background, threshold, what) => {
    const ratio = on(token, background);

    expect(ratio, `${what} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(threshold);
  });

  /**
   * The three section accents. They are not decoration: they colour the eyebrow above a
   * heading, the current entry in the sidebar and the title of a hovered card, all of
   * which are text a reader has to be able to read.
   */
  it.each(["--tone-0", "--tone-1", "--tone-2"])("%s, which is text and not just a stripe", (token) => {
    const ratio = on(token, "--surface");

    expect(ratio, `${token} is ${ratio.toFixed(2)}:1 on a card`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("gives form controls a boundary people can see", () => {
    // WCAG 1.4.11. This started at 1.66:1 — visible to most people, invisible to some,
    // and the sort of thing that is only ever found by computing it.
    const ratio = on("--control-border", "--paper");

    expect(ratio, `the search field's border is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_LARGE,
    );
  });

  it("keeps highlighted text readable inside the highlight", () => {
    // A search result's `<mark>` is the one place text sits on a colour chosen for
    // attention rather than for contrast.
    const ratio = contrastRatio(colour(palette, "--mark"), colour(palette, "--mark-ink"));

    expect(ratio, `a marked term is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });
}

describe("light palette meets AA", () => assertPaletteMeetsAA(light));

// The dark block redeclares only what changes, so anything it leaves alone is inherited
// from the light one — which is also how the browser resolves it.
describe("dark palette meets AA", () => assertPaletteMeetsAA({ ...light, ...dark }));

/**
 * The property that makes everything above true.
 *
 * These ratios are computed from the two token blocks. A colour written inline further
 * down the sheet would render on a merchant's screen without ever being measured here, so
 * the sheet is not allowed to contain one.
 */
describe("every colour is a token", () => {
  it("declares no hex outside the two palette blocks", () => {
    const elsewhere = HELP_STYLES.replace(/:root\s*\{[^}]*\}/g, "");
    const stray = [...elsewhere.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);

    expect(stray, "a colour the contrast test cannot see").toEqual([]);
  });

  it("would notice one — the assertion above is worthless if it cannot fail", () => {
    const tampered = `${HELP_STYLES}\n.help .card { color: #ff0000; }`;
    const elsewhere = tampered.replace(/:root\s*\{[^}]*\}/g, "");

    expect([...elsewhere.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0])).toEqual(["#ff0000"]);
  });

  it("names a colour by token in the places a reader looks", () => {
    for (const token of ["--ink", "--muted", "--accent", "--tone-0", "--mark"]) {
      expect(HELP_STYLES, `${token} is declared but never used`).toContain(`var(${token})`);
    }
  });
});
