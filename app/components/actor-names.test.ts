/**
 * Who did something is shown by name, never as the stored id (#956).
 *
 * The price-import history's "By" column printed `staff:91614707946` where Activity, for
 * the same person, says "Staff 7946". Every stored actor goes through `describeActor`.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

const ACTOR_FIELDS = /\.(createdBy|capturedBy|resolvedBy|approvedBy|requestedBy|decidedBy)\b/;

describe("stored actor ids on screen", () => {
  const files = sourceFiles("app/components", "app/routes").filter((f) => f.endsWith(".tsx") && !/ \d+\.tsx$/.test(f));

  it("reads some files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s names every actor it shows through describeActor", (file) => {
    const raw = sourceOf(file)
      .split("\n")
      .filter((line) => ACTOR_FIELDS.test(line) && !line.includes("describeActor("));
    expect(raw, "render it as describeActor(value), as Activity does").toEqual([]);
  });
});
