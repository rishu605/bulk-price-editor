/**
 * No count in merchant copy says "(s)" (#1078).
 *
 * "1 product(s) could not be tagged", "3669 price(s) read back": a hedge where the app knows
 * the number. Every count goes through `countOf` and `formatCount` (#759), and this keeps a
 * new one from coming back. Prose only -- a word, "(s)", another word -- outside comments, so
 * a call such as `describeState(s)` is not prose.
 */

import { describe, expect, it } from "vitest";

import { rawSource, sourceFiles, withoutComments } from "../testing/source";

describe('"(s)" in merchant copy (#1078)', () => {
  it("is nowhere under app/", () => {
    // Editors' numbered copies ("run.server 2.ts") are not the app's source.
    const files = sourceFiles("app").filter((file) => !/ \d+\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
    const offenders = files.flatMap((file) =>
      withoutComments(rawSource(file))
        .split("\n")
        .filter((line) => /[a-z]\(s\) [a-z]/i.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
