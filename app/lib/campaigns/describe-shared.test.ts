import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { describeCampaign } from "./describe";

/** Comments only, so prose about the formatter cannot masquerade as a call to it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const LIST = "app/services/campaigns/list.server.ts";
const DETAIL = "app/routes/app.campaigns.$id.tsx";

/**
 * The one call, wherever it is made.
 *
 * The call is a spread — `...describeCampaign({ ... })` — because both surfaces put the
 * two sentences straight into a row or a loader payload. Matching the spread is what
 * makes this a check of the real call and not of a mention in a comment.
 */
function describeCall(file: string): string {
  const source = readFileSync(file, "utf8");
  const call = /\.\.\.describeCampaign\(\{[^}]*\}\)/.exec(source)?.[0];

  expect(call, `${file} no longer builds its sentences with describeCampaign`).toBeTruthy();
  return call as string;
}

describe("the campaigns index and the campaign page describe a campaign the same way", () => {
  it("passes the same three things, from the same accessors", () => {
    // The failure this exists for is not "one surface stopped calling the formatter" --
    // that one is loud, because the column goes blank. It is the quiet one: both call it,
    // but the index passes `segmentName` and the campaign page forgets to, so a campaign
    // scoped to a saved segment reads "In Outerwear" in the list and "Tagged sale" on its
    // own page. Two true sentences about one campaign, and a merchant has no way to know
    // which is the one that will run.
    //
    // So the arguments are compared, not merely the presence of the call. The record
    // variable is named `c` in the list's `map` and `record` in the loader; normalising it
    // is the only difference either file is allowed.
    const normalise = (call: string) => call.replace(/\b(?:c|record)\b/g, "×");

    expect(normalise(describeCall(LIST))).toBe(normalise(describeCall(DETAIL)));
  });

  it("keeps every surface on the pair, not on one half of it", () => {
    // Calling `describeRule` alone is how the two sentences drift apart: a surface that
    // wants only the rule today grows an `Applies to` column tomorrow, writes its own
    // scope line because the import is already one function short, and now there are two
    // answers again. Going through `describeCampaign` makes the pair the unit.
    //
    // Comments are stripped before the grep. This is the sixth time in this repo a
    // source-level check has been fooled by its own subject appearing in prose -- the
    // note in `editor-layout.test.ts` records the last one, and #462 is open to extract
    // this into something shared.
    // Tracked and untracked-but-not-ignored: a new file is the likeliest place for a
    // second formatter, and `git ls-files` alone cannot see one until it is committed.
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "app"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !f.includes(".test.") && !f.startsWith("app/lib/campaigns/describe"));

    const offenders = files.filter((f) =>
      /\bdescribe(?:Rule|Scope)\(/.test(withoutComments(readFileSync(f, "utf8"))),
    );

    expect(offenders, "call describeCampaign, which returns both").toEqual([]);
  });
});

describe("describeCampaign", () => {
  it("names the segment as the scope when there is one", () => {
    // The argument the two call sites are compared on, exercised for real: a segment
    // replaces the inline filter rather than narrowing it, so where there is one it is
    // the whole answer to "applies to".
    expect(
      describeCampaign({
        rule: { kind: "percent-change", percent: -20 },
        ast: { groups: [{ conditions: [{ field: "tag", value: "sale" }] }] },
        segmentName: "Winter clearance",
      }),
    ).toEqual({ rule: "20% off", scope: "Winter clearance" });
  });

  it("still answers when a campaign has neither", () => {
    // A draft in its first second exists with no rule row and no filter, and the index
    // lists drafts. Blank cells in two columns read as a broken page.
    expect(describeCampaign({ rule: null, ast: null })).toEqual({
      rule: "No rule",
      scope: "All variants",
    });
  });
});
