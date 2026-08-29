/**
 * One list of scope fields, read by everything that reads a scope.
 *
 * The bug this exists for has no symptom until a merchant is looking at a price. The
 * editor's create action builds an AST from the form; `draftCampaignFrom` builds one for
 * the preview from the same fields. If the two lists diverge, the merchant sets a
 * condition, watches the preview account for it, and gets a campaign that does not — or
 * the reverse, which is worse, because the preview is then the thing that lied.
 *
 * Rule 4: preview and execution share one code path. That is a rule about the *inputs*
 * too, and this is where a divergence would start.
 *
 * Found by mutation: removing `excludeTag` from the preview's list broke nothing at all.
 */

import { describe, expect, it } from "vitest";

import { SCOPE_CONDITION_FIELDS } from "./draft-form";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");

describe("the editor and the preview read the same fields", () => {
  it("builds the campaign's AST from the shared list, not from a literal", () => {
    // A literal array here is how the two drift: it looks identical on the day it is
    // written and nobody updates both.
    expect(EDITOR).toContain("for (const field of SCOPE_CONDITION_FIELDS)");
    expect(
      EDITOR,
      "a hand-written field list in the action is how the preview and the run stop agreeing",
    ).not.toMatch(/for \(const field of \[/);
  });

  it("derives the form's field list from the same one", () => {
    // `SCOPE_FIELDS` is the form's list and differs only by `segment`, which is not a
    // condition — it resolves to a whole AST of its own.
    expect(EDITOR).toContain("[...SCOPE_CONDITION_FIELDS, \"segment\"]");
  });

  /**
   * The list, written down a second time on purpose.
   *
   * Everywhere else in this repo a duplicated list is the bug. Here it is the check: the
   * production copies were unified in the same change that added `excludeTag`, so a field
   * dropped from the shared list vanishes from the action, from the preview *and* from
   * any assertion derived from it — three things agreeing, all wrong, silently.
   *
   * Found by mutation: the first version of this file compared the shared list against
   * itself through the form, and passed happily while the exclusion was deleted.
   *
   * Adding a field here is the deliberate act that says a merchant is meant to be able to
   * set it. Removing one says the opposite.
   */
  const EXPECTED = ["collection", "excludeTag", "tag", "title", "vendor"];

  it("offers exactly the conditions a merchant is meant to be able to set", () => {
    expect([...SCOPE_CONDITION_FIELDS].sort()).toEqual(EXPECTED);
  });

  it("has a control in the form for every one of them", () => {
    // A field nothing renders is a scope a merchant cannot reach.
    //
    // `[\s\S]*?` and not a space: a control with several attributes is written across
    // lines, and a single-line pattern silently found four of the five.
    const named = new Set(
      [...EDITOR.matchAll(/<s-(?:select|text-field)[\s\S]*?name="([a-zA-Z]+)"/g)].map(
        (match) => match[1]!,
      ),
    );

    expect(EXPECTED.filter((field) => !named.has(field))).toEqual([]);
  });
});
