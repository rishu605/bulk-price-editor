/**
 * The export button names one row in the singular, as the caller spells it (#947).
 *
 * It trimmed a trailing "s" off the plural, which made one activity entry
 * "Export the 1 entrie (CSV)".
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

import { ExportButton, exportLabel } from "./ExportButton";

/** Every `noun={["one", "many"]}` an `<ExportButton>` is given, plus the default. */
function nounsInUse(): Array<[string, string]> {
  const nouns: Array<[string, string]> = [["row", "rows"]];
  for (const file of sourceFiles("app").filter((f) => f.endsWith(".tsx") && !/ \d+\.tsx$/.test(f))) {
    for (const tag of sourceOf(file).match(/<ExportButton\b[^>]*>/g) ?? []) {
      const noun = tag.match(/noun=\{\[\s*"([^"]+)",\s*"([^"]+)"\s*\]\}/);
      if (noun) nouns.push([noun[1], noun[2]]);
      else expect(tag, `${file}: an ExportButton's noun must be [singular, plural]`).not.toMatch(/noun=/);
    }
  }
  return nouns;
}

describe("the export button's label", () => {
  it("reads one activity entry as 'entry', not 'entrie'", () => {
    expect(exportLabel(1, ["entry", "entries"])).toBe("Export the 1 entry (CSV)");
    expect(exportLabel(1204, ["entry", "entries"])).toBe("Export all 1,204 entries (CSV)");
  });

  it("finds the activity page's noun among the ones in use", () => {
    expect(nounsInUse()).toContainEqual(["entry", "entries"]);
  });

  it.each(nounsInUse())("renders one %s in the singular", (singular, plural) => {
    expect(singular).not.toBe(plural);
    const html = renderToStaticMarkup(<ExportButton href="/x" filename="x.csv" rows={1} noun={[singular, plural]} />);
    expect(html).toContain(`Export the 1 ${singular} (CSV)`);
  });
});
