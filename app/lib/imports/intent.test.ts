/**
 * A missing intent must not write to a merchant's catalogue.
 *
 * This is the one property in the import flow that cannot be seen. A dry run that has
 * quietly become a commit looks identical until the prices change, so it is checked
 * against the values that would actually arrive rather than against the spelling of the
 * comparison that decides.
 */

import { describe, expect, it } from "vitest";

import { isCommit } from "./intent";

describe("only an exact commit commits", () => {
  it("commits when asked", () => {
    expect(isCommit("commit")).toBe(true);
  });

  it.each([
    ["nothing at all", null],
    ["a field that never arrived", undefined],
    ["an empty field", ""],
    ["the dry run", "dry-run"],
    ["a different case", "Commit"],
    ["a stray space", "commit "],
    ["the namespaced one, read without its namespace", "import-commit"],
    ["an uploaded file where a string was expected", new File([], "x.csv")],
  ])("falls safe on %s", (_why, value) => {
    expect(isCommit(value as FormDataEntryValue | null)).toBe(false);
  });
});

describe("a route that runs two check-then-commit flows can tell them apart", () => {
  it("commits the import only for the import's own value", () => {
    expect(isCommit("import-commit", "import-commit")).toBe(true);
    expect(isCommit("commit", "import-commit")).toBe(false);
  });

  it("does not let the page's own commit trigger the import, or the reverse", () => {
    // The cost page bulk-edits costs *and* imports them. One `intent` field cannot mean
    // two things, and the failure mode if it did is a merchant pressing "Change these
    // costs" and getting a file written instead.
    expect(isCommit("import-commit")).toBe(false);
    expect(isCommit("commit", "import-commit")).toBe(false);
  });
});
