/**
 * Reading this app's own source, for the tests that check it as text.
 *
 * A dozen tests here assert something about a file rather than about a value: that the
 * campaign editor puts the rule before the scope, that no component hard-codes a row
 * limit, that nothing reaches for a native `<form`. Those checks are worth having —
 * several guard behaviour that only exists in a browser — and they all share one failure.
 *
 * ## The trap
 *
 * A test greps for a string, and a *comment explaining that string* satisfies the grep.
 * It has now happened seven times in this repo. The two that make the point:
 *
 *   - The check that no route uses a native form element greps for `<form`, and a comment
 *     saying why a route must not use one contains `<form`.
 *   - The editor layout check asserts the "Update match count" button is gone, and the
 *     comment recording that it was removed names it.
 *
 * Both times the rule fired on the note documenting compliance with it. That is worse
 * than a rule with a gap, because it teaches people that writing the explanation breaks
 * the build — and the explanation is the part that survives longest.
 *
 * ## Whole-line comments only
 *
 * `// ...` is stripped only where the line is nothing else, so the `//` in an `https://`
 * href is left alone. A stripper that took everything after `//` anywhere would quietly
 * delete half of every URL in the file being checked, and a grep for a link would then
 * fail for a reason nobody would guess.
 *
 * Block comments go wherever they are, including the trailing block comment after code,
 * because JSX comments are written that way and are the ones most likely to describe the
 * markup beside them.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

/** Source with its own commentary removed. See the note above for why only some of it. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * One file's source, comments removed, read from the repo root.
 *
 * The path is repo-relative and joined here, so a test never repeats `process.cwd()` —
 * which is the other half of what these files kept copying.
 */
export function sourceOf(...parts: string[]): string {
  return withoutComments(rawSource(...parts));
}

/**
 * The same file, exactly as written.
 *
 * For the checks that are genuinely about the prose — the compliance sheet counting its
 * own assertions, this helper's own test — and for reading anything that is not
 * TypeScript. Saying `rawSource` rather than reaching for `readFileSync` is the point:
 * it makes "I meant to keep the comments" a decision somebody wrote down.
 */
export function rawSource(...parts: string[]): string {
  // `resolve` rather than `join`, so a caller that already has an absolute path — the
  // directory walkers here all build one — gets that path rather than the repo root with
  // an absolute path glued onto the end of it.
  return readFileSync(resolve(ROOT, ...parts), "utf8");
}

/**
 * Every TypeScript source file under the given paths — tracked, and untracked ones git is
 * not ignoring.
 *
 * The untracked half is not a detail. A guard that lists only committed files cannot see
 * the file being added in the very commit under review, which is the likeliest place for
 * a new offender: a deliberately-broken copy of the no-delete rule passed for exactly
 * that reason while it was being written.
 *
 * Test files are left out. They assert *about* the strings being grepped for — a control
 * name, a URL, a literal — and are the other half of the same trap the comment stripping
 * exists for. A check that wants them can list them itself.
 */
export function sourceFiles(...paths: string[]): string[] {
  return listed(...paths).filter((file) => !file.includes(".test."));
}

/** The other half: only the test files, for the checks that are about the checks. */
export function testFiles(...paths: string[]): string[] {
  return listed(...paths).filter((file) => file.includes(".test."));
}

function listed(...paths: string[]): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file));
}
