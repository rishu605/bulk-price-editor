/**
 * No grid item spans more columns than its grid has at its narrowest (#725).
 *
 * CSS does not clamp a span to the tracks that exist; it creates the missing ones as
 * `auto`, and the grid turns into content-sized columns. Measured against the real Polaris
 * at a 480px container, Baselines' filters came out `196.75px 125.625px 125.625px` where
 * the one-column branch should have been `480px` (#678 was the same thing in the editor).
 *
 * And a span cannot follow the grid's container query: `s-grid-item`'s `gridColumn` takes
 * `auto` or `span N`, and the runtime turns anything else into `auto`. So both are refused
 * here, and a full row in a responsive grid is a `FullRow` in a `SplitGrid` instead.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

/** Track counts of a template literal: each branch of a responsive value, or the one. */
export function trackCounts(template: string): number[] {
  const branches = template.trim().startsWith("@container")
    ? template.replace(/^@container\s*\([^)]*\)\s*/, "").split(",")
    : [template];
  return branches.map((branch) => tracks(branch.trim()));
}

/** Tracks in one branch, a function such as `minmax(0, 1fr)` counting once. */
function tracks(branch: string): number {
  let depth = 0;
  let count = 0;
  let inToken = false;
  for (const char of branch) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    const space = /\s/.test(char) && depth === 0;
    if (!space && !inToken) count += 1;
    inToken = !space;
  }
  return count;
}

interface Offence {
  file: string;
  what: string;
}

/** Every `gridColumn` in a file, checked against the `s-grid` it sits in. */
export function offences(file: string, source: string): Offence[] {
  const found: Offence[] = [];

  // The grid each position sits in: the innermost one still open there. An item rendered
  // by a component of its own (a step's row, a fragment returned from a helper) has none
  // open around it in the source, and is checked against the file's outermost grid --
  // the one such a component is written to be placed in.
  const tags = [...source.matchAll(/<s-grid(?![-\w])([^>]*)>|<\/s-grid>/g)];
  const templateOf = (attributes: string) => /gridTemplateColumns="([^"]*)"/.exec(attributes)?.[1] ?? null;
  const outermost = tags.find((tag) => !tag[0].startsWith("</"));
  const gridAt = (position: number): { template: string | null } | undefined => {
    const stack: Array<{ template: string | null }> = [];
    for (const tag of tags) {
      if (tag.index! > position) break;
      if (tag[0].startsWith("</")) stack.pop();
      else stack.push({ template: templateOf(tag[1] ?? "") });
    }
    return stack[stack.length - 1] ?? (outermost ? { template: templateOf(outermost[1] ?? "") } : undefined);
  };

  for (const match of source.matchAll(/gridColumn=(?:"([^"]*)"|\{\s*["'`]([^"'`]*)["'`]\s*\}|\{([^}]*)\})/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (/@container/.test(value) || match[3] !== undefined) {
      found.push({ file, what: `gridColumn={${value.trim()}}: the runtime reads anything but "span N" as auto` });
      continue;
    }
    const span = /^span (\d+)$/.exec(value.trim());
    if (!span) continue;
    const grid = gridAt(match.index!);
    if (!grid || grid.template === null) {
      found.push({ file, what: `${value} in a grid whose columns this check cannot read` });
      continue;
    }
    const narrowest = Math.min(...trackCounts(grid.template));
    if (Number(span[1]) > narrowest) {
      found.push({ file, what: `${value} in "${grid.template}", which has ${narrowest} at its narrowest` });
    }
  }
  return found;
}

describe("grid spans", () => {
  it("never exceed the grid's narrowest branch, and never follow a query", () => {
    const files = sourceFiles("app")
      .filter((file) => file.endsWith(".tsx") && !/ \d+\.tsx$/.test(file))
      .filter((file) => /gridColumn=/.test(sourceOf(file)));
    expect(files.length, "the guard found no grid items to check").toBeGreaterThan(0);
    expect(files.flatMap((file) => offences(file, sourceOf(file)))).toEqual([]);
  });

  it("counts tracks per branch, a function as one", () => {
    expect(trackCounts("@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr")).toEqual([1, 3]);
    expect(trackCounts("auto 1fr auto auto")).toEqual([4]);
    expect(trackCounts("minmax(0, 1fr) auto")).toEqual([2]);
  });

  it("catches the three #725 found, as they were", () => {
    const variantSearch = `<s-grid gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr"><s-grid-item gridColumn="span 2">x</s-grid-item></s-grid>`;
    const onboarding = `<s-grid gridTemplateColumns="@container (inline-size <= 500px) auto 1fr, auto 1fr auto auto"><s-grid-item gridColumn="span 4">x</s-grid-item></s-grid>`;
    const fullRow = `<s-grid gridTemplateColumns="1fr 1fr"><s-grid-item gridColumn={FULL_ROW_SPAN}>x</s-grid-item></s-grid>`;
    expect(offences("a", variantSearch)).toHaveLength(1);
    expect(offences("b", onboarding)).toHaveLength(1);
    expect(offences("c", fullRow)).toHaveLength(1);
    // And lets the honest ones through.
    expect(offences("d", `<s-grid gridTemplateColumns="auto 1fr"><s-grid-item gridColumn="span 2">x</s-grid-item></s-grid>`)).toEqual([]);
  });
});
