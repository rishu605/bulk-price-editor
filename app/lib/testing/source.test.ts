/**
 * The helper that keeps a dozen source-level checks from reading their own explanations.
 *
 * Worth testing directly because every one of its callers only fails *silently* when it
 * is wrong: a stripper that removes too little makes a guard fire on a comment, and one
 * that removes too much makes a guard stop firing at all. The second is the dangerous
 * one, and nothing downstream would notice.
 */

import { describe, expect, it } from "vitest";

import { rawSource, sourceFiles, sourceOf, withoutComments } from "./source";

describe("withoutComments", () => {
  it("removes a whole-line comment that names the thing being grepped for", () => {
    // The trap itself, seven times over: the check that no route uses a native form
    // element greps for the tag, and the comment saying why trips it.
    const source = ['// never reach for a native <form here', 'const x = "<s-box>";'].join("\n");

    expect(withoutComments(source)).not.toContain("<form");
    expect(withoutComments(source)).toContain("<s-box>");
  });

  it("removes a block comment wherever it sits, including beside code", () => {
    expect(withoutComments("/* Update match count was removed */\nconst a = 1;")).not.toContain(
      "Update match count",
    );
    expect(withoutComments("const a = 1; /* and why */")).toContain("const a = 1;");
    expect(withoutComments("const a = 1; /* and why */")).not.toContain("and why");
  });

  it("removes a JSX comment, which is a block comment in braces", () => {
    const jsx = '{/* the Search button posts to /app/campaigns */}\n<s-button>Go</s-button>';

    expect(withoutComments(jsx)).not.toContain("Search button");
    expect(withoutComments(jsx)).toContain("<s-button>");
  });

  it("leaves the slashes in a URL alone", () => {
    // The reason only whole-line `//` goes. A stripper that took everything after `//`
    // anywhere would delete half of every link in the file, and a guard checking a href
    // would then fail for a reason nobody would guess.
    const source = 'const help = "https://help.example.com/pricing";';

    expect(withoutComments(source)).toContain("https://help.example.com/pricing");
  });

  it("leaves a trailing comment's code intact", () => {
    expect(withoutComments("const rows = 40; // not a table")).toContain("const rows = 40;");
  });

  it("keeps the line count, so a check that counts lines still can", () => {
    // `table-size.test.ts` and the route-length guards read positions and counts out of
    // the same string. Collapsing the stripped lines would move every line after a
    // comment and make those numbers quietly wrong.
    expect(withoutComments("// a\n// b\nconst x = 1;").split("\n")).toHaveLength(3);
  });
});

describe("sourceOf", () => {
  it("reads a file from the repo root with its commentary gone", () => {
    const source = sourceOf("app/lib/testing/source.ts");

    expect(source).toContain("export function withoutComments");
    // This file's own header explains the trap at length. If any of it survives, the
    // helper is not doing to itself what it does to everything else.
    expect(source).not.toContain("The trap");
  });

  it("hands back the comments when a check actually wants them", () => {
    expect(rawSource("app/lib/testing/source.ts")).toContain("The trap");
  });
});

describe("sourceFiles", () => {
  const files = sourceFiles("app");

  it("lists source and leaves out tests", () => {
    // Tests assert *about* the control names and URLs a guard greps for, which is the
    // other half of the trap the comment stripping exists for.
    expect(files).toContain("app/lib/testing/source.ts");
    expect(files.filter((f) => f.includes(".test."))).toEqual([]);
  });

  it("asks git for untracked files too", () => {
    // Not observable from the result on a clean tree, so this checks the flag rather than
    // the output. Without it a guard cannot see the file being added in the very commit
    // under review — which is where a new offender lives.
    expect(rawSource("app/lib/testing/source.ts")).toContain('"--others", "--exclude-standard"');
  });
});
