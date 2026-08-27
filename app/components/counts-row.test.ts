/**
 * One implementation of the counts row, not two.
 *
 * The dashboard hand-rolled the same four tiles the shared component renders — an
 * `s-box` with a label and a figure, in an inline stack. When `CountsRow` gained borders,
 * padding and equal columns, the dashboard kept the old flat look, because it had never
 * been using it.
 *
 * That is the first screen after installing, so it is the worst place in the app to be a
 * version behind. And the duplication is invisible: both render four numbers, and only a
 * side-by-side comparison shows one of them is the old one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "app");

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) return [];
    return [{ path: path.replace(`${APP}/`, ""), text: readFileSync(path, "utf8") }];
  });
}

describe("the counts row", () => {
  it("is rendered by the shared component wherever it appears", () => {
    // A label in an `s-box` immediately above a figure in an `s-heading` is the shape of
    // a stat tile. Anywhere but CountsRow itself, it is a second copy.
    const handRolled = sources(APP)
      .filter(({ path }) => path !== "components/CountsRow.tsx")
      .filter(({ text }) => /<s-box>\s*<s-text>[^<]+<\/s-text>\s*<s-heading>/.test(text))
      .map(({ path }) => path);

    expect(
      handRolled,
      "these draw their own stat tiles, so they will not pick up changes to CountsRow",
    ).toEqual([]);
  });

  it("is actually used by the dashboard", () => {
    // Guards the other direction: deleting the duplicate without adopting the component
    // would leave the first screen with no counts at all and still pass the check above.
    const dashboard = readFileSync(join(APP, "routes", "app._index.tsx"), "utf8");
    expect(dashboard).toContain("<CountsRow");
  });
});
