/**
 * The editor and the help centre define "baseline" the same way.
 *
 * The word is the product. `docs/help/concepts/baselines.md` opens with the definition —
 * *the price a product would be if no campaign were running* — and calls that one
 * sentence "the whole product". If the editor explains it differently, a merchant who
 * reads both has been handed two concepts and will trust neither.
 *
 * This is the failure the repo has already seen once in a smaller form: drift's buttons
 * were labelled `adopt`/`reassert`/`ignore` while `docs/help/concepts/drift.md` had
 * merchant wording for two of them since before the page existed.
 *
 * Checked against the document rather than against a copy of it, so the day somebody
 * improves the help centre's sentence this fails instead of quietly disagreeing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** Source without its own commentary, which discusses the very words being grepped. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const EDITOR = code(read("app/routes/app.campaigns.new.tsx"));
const PREVIEW = code(read("app/components/DraftPreview.tsx"));
const EXAMPLE = code(read("app/components/StorefrontExample.tsx"));
const OVERLAP = code(read("app/components/OverlapPanel.tsx"));
const CONCEPT = read("docs/help/concepts/baselines.md");
const REVERT = read("docs/help/concepts/revert.md");

/** JSX wraps prose across lines; compare on words, not on whitespace. */
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the editor defines baseline the way the help centre does", () => {
  it("uses the help centre's own definition", () => {
    // "the price a product would be if no campaign were running"
    expect(flat(CONCEPT)).toContain("the price a product would be if no campaign were running");
    expect(flat(EDITOR)).toContain("the price it would be if no campaign were running");
  });

  it("names the baseline where the rule is entered, not only in a note at the foot", () => {
    const rule = EDITOR.indexOf("<RuleValueField");
    const advanced = EDITOR.indexOf("Advanced (optional)");

    expect(rule).toBeGreaterThan(-1);
    expect(
      EDITOR.indexOf("baseline", rule),
      "the word appears only after the settings a merchant is told to skip",
    ).toBeLessThan(advanced);
  });

  it("states the consequence, which is the part that sells it", () => {
    // Running it twice is the scenario RUBIX's FAQ has to explain going wrong.
    expect(flat(EDITOR)).toContain("running this campaign twice gives the same result");
  });
});

describe("everything that mentions the baseline agrees", () => {
  it("calls it a baseline, never an original or a normal price", () => {
    for (const [name, source] of [
      ["the editor", EDITOR],
      ["the preview", PREVIEW],
      ["the storefront example", EXAMPLE],
    ] as const) {
      expect(source, `${name} calls it something else`).toContain("baseline");
      expect(flat(source), `${name} says "original price"`).not.toMatch(/original price/i);
    }
  });

  it("does not describe reverting as restoring, anywhere", () => {
    // `docs/help/concepts/revert.md`: "Reverting a campaign does not restore the prices
    // that were there before." Every competitor's revert does exactly that, so the word
    // is the difference and must not leak into our copy.
    expect(flat(REVERT)).toContain("does not restore the prices that were there before");

    for (const [name, source] of [
      ["the preview", PREVIEW],
      ["the overlap panel", OVERLAP],
      ["the editor", EDITOR],
    ] as const) {
      expect(flat(source), `${name} describes a revert as restoring`).not.toMatch(
        /revert\w*[^.]{0,40}restor/i,
      );
    }
  });

  it("says recompute where it talks about reverting at all", () => {
    expect(flat(OVERLAP)).toContain("recomputes");
  });
});
