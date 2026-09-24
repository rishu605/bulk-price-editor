/**
 * Every test file this repo contains is a test file vitest actually runs.
 *
 * `app/lib/ui/type-roles.test 2.ts` was committed and never ran. Vitest collects
 * `app/**\/*.test.{ts,tsx}`, and the editor's duplicate is named `type-roles.test 2.ts`
 * — the segment after `.test` is ` 2.ts`, so the glob does not match and the file was
 * silently skipped for as long as it existed.
 *
 * Silently is the whole problem. It asserted the *opposite* of its live sibling: the
 * `{ type: "small" }` cast that `Type.tsx` carried for one release and then dropped,
 * once the deployed page proved the runtime does not implement it. Had it been collected
 * it would have failed every run since. Instead the suite was green, the file count read
 * as normal, and nothing anywhere said a test had stopped existing.
 *
 * A test that does not run is worse than a test that was never written, because the file
 * in the tree is what stops anybody writing it again.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The roots `vitest.config.ts` collects from. Kept in step with its `include`. */
const ROOTS = ["app", "scripts"];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // `node_modules` never appears under these roots, but a build artefact directory
      // could, and walking one would make this assert about generated files.
      return entry.name === "node_modules" ? [] : filesUnder(path);
    }
    return [path];
  });
}

const all = ROOTS.flatMap((root) => filesUnder(join(process.cwd(), root)));

/** Anything that reads as a test to a person scanning the tree. */
const looksLikeATest = (path: string) => /\.test\b/.test(path) || /\.spec\b/.test(path);

/** What `vitest.config.ts` will actually collect. */
const isCollected = (path: string) => path.endsWith(".test.ts") || path.endsWith(".test.tsx");

describe("no test file is invisible to the runner", () => {
  it("found the tree, so this cannot pass by checking nothing", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.filter(isCollected).length).toBeGreaterThan(100);
  });

  it("every file that reads as a test is one vitest collects", () => {
    const skipped = all
      .filter(looksLikeATest)
      .filter((path) => !isCollected(path))
      .map((path) => path.replace(`${process.cwd()}/`, ""));

    expect(
      skipped,
      "these name themselves tests and vitest does not run them — rename to " +
        "`<name>.test.ts` or delete them, but do not leave them in the tree",
    ).toEqual([]);
  });

  it("no source file is an editor's duplicate", () => {
    // `Type 2.tsx` sat beside `Type.tsx` for a release, imported by nothing and swept up
    // by the type-roles audit as though it were live code. The trailing " 2" is what a
    // copy in Finder and several editors produce, so it is worth naming directly.
    const duplicates = all
      .filter((path) => / \d+\.(ts|tsx|js|jsx|prisma|sql)$/.test(path))
      .map((path) => path.replace(`${process.cwd()}/`, ""));

    expect(duplicates, "a copied file committed by accident").toEqual([]);
  });
});
