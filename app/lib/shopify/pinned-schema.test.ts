/**
 * The pinned schema is present, committed, and the one the app speaks.
 *
 * `API_VERSION` and `app/types/admin-<version>.schema.json` are two halves of one
 * decision. Codegen names the file after the version, so bumping the pin without
 * refreshing leaves the old file orphaned and silently downloads a new one on whichever
 * machine runs codegen next — which is exactly the split-brain #591 closed.
 *
 * ## Why this is worth a test rather than a note
 *
 * The failure is invisible in the place you would look. Every generated type still
 * typechecks, every query still validates, and the only symptom is that CI and a laptop
 * disagree about a file neither of them shows you. That is the same shape as the bug
 * itself, so a comment saying "remember to refresh" is not a guard; it is the thing that
 * was already there.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION_STRING } from "./api-version";

const ROOT = process.cwd();
const TYPES = join(ROOT, "app", "types");

describe("the pinned Admin schema", () => {
  it("exists for the version the app speaks", () => {
    const expected = join(TYPES, `admin-${API_VERSION_STRING}.schema.json`);

    expect(
      existsSync(expected),
      `No schema for the pinned API version. Run \`npm run graphql-codegen:refresh\` and ` +
        `commit app/types/admin-${API_VERSION_STRING}.schema.json.`,
    ).toBe(true);
  });

  it("is the only one, so a bumped pin cannot leave the old one behind", () => {
    const schemas = readdirSync(TYPES).filter((name) => /^admin-.*\.schema\.json$/.test(name));

    expect(
      schemas,
      "more than one pinned schema means the version was bumped without tidying up, and " +
        "nothing says which one codegen used",
    ).toEqual([`admin-${API_VERSION_STRING}.schema.json`]);
  });

  it("is committed rather than ignored, which is the whole fix", () => {
    // The guard on the guard. Re-adding the ignore rule would restore #591 exactly:
    // everything here would still pass on the machine that has the file cached, and CI
    // would go back to downloading a schema that drifts under unrelated PRs.
    const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const rule of ignored) {
      expect(
        /admin-.*schema\.json/.test(rule),
        `.gitignore rule "${rule}" would un-commit the pinned schema`,
      ).toBe(false);
    }
  });

  it("is a real introspection result and not an empty placeholder", () => {
    // Cheap, and it earns itself: a truncated or half-written download is a file that
    // exists, passes every check above, and produces types that are quietly wrong.
    const file = join(TYPES, `admin-${API_VERSION_STRING}.schema.json`);
    expect(statSync(file).size).toBeGreaterThan(1_000_000);

    const schema = JSON.parse(readFileSync(file, "utf8"));
    const types = schema?.__schema?.types ?? schema?.data?.__schema?.types;

    expect(Array.isArray(types), "the file should hold an introspected schema").toBe(true);
    expect(types.length).toBeGreaterThan(100);
  });
});
