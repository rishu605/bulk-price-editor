/**
 * Prose uses the named roles rather than choosing its elements by hand.
 *
 * `spacing.ts` names every distance and `FieldGrid` names every width. Type had nothing,
 * so each route picked between `<s-paragraph>`, `<s-text color="subdued">` and a bare
 * string itself — and the app ended up with five roles rendered in three treatments, two
 * of which were identical. A card's lede and a field's label were the same 15px regular
 * black; a card's secondary prose and a field's helper were two different greys.
 *
 * The specific shape this refuses is the one that was written twenty-one times: a
 * paragraph whose only content is subdued text. That is `Secondary`, and writing it out
 * is how the rank drifts — the next one gets a different size, or forgets the grey, and
 * nothing says which was intended.
 *
 * `s-text color="subdued"` *inside* a sentence stays allowed and is not this: a phrase
 * greyed down mid-paragraph is emphasis, not a rank.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");

/** Every `.tsx` under `app/`, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

const files = sources(APP).map((path) => ({
  path: path.replace(`${APP}/`, ""),
  source: sourceOf(path),
}));

/** A paragraph whose entire content is one subdued text — `Secondary`, written out. */
const HAND_ROLLED = /<s-paragraph>\s*<s-text color="subdued">[\s\S]*?<\/s-text>\s*<\/s-paragraph>/;

describe("the type roles", () => {
  it("finds the files, so this cannot pass by checking nothing", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it("nobody writes Secondary out by hand", () => {
    const offenders = files
      .filter(({ source }) => HAND_ROLLED.test(source.replace(/\n\s*/g, "\n")))
      .map(({ path }) => path);

    expect(
      offenders,
      "a paragraph of subdued text is `Secondary` — writing it out is how the rank drifts",
    ).toEqual([]);
  });

  it("names three ranks and says what each is for", () => {
    const type = sourceOf(join(APP, "components", "Type.tsx"));

    expect(type).toContain("export function Lede");
    expect(type).toContain("export function Secondary");
    expect(type).toContain("export function Caption");
  });

  it("keeps the subordinate ranks quiet, by one decision rather than twenty-one", () => {
    // Colour is the only de-emphasis lever the typed API has — `type="small"` shipped
    // once and rendered byte-for-byte identically on the deployed page, so the runtime
    // does not implement it either. What is left is worth holding: one grey, here.
    const type = sourceOf(join(APP, "components", "Type.tsx"));

    expect(type).toMatch(/<s-paragraph color="subdued">/);
    expect(type).toMatch(/<s-text color="subdued">/);
    expect(type, "the size lever does not work — see the note in Type.tsx").not.toContain(
      'type: "small"',
    );
  });

  it("does not put field labels or helper text in here", () => {
    // Polaris fields own `label` and `details`. A second way to render either is a way
    // for the two to disagree with what Polaris draws.
    const type = sourceOf(join(APP, "components", "Type.tsx"));

    expect(type).not.toContain("export function FieldLabel");
    expect(type).not.toContain("export function Helper");
  });
});
