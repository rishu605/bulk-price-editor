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
import { PRODUCT_STATUS_FIELDS } from "./product-status";
import { BUILDER_FIELDS, FIELD_SPECS } from "../segments/scope-builder";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
const DRAFT_INPUT = sourceOf("app/services/campaigns/draft-input.server.ts");
const BUILDER = sourceOf("app/components/scope/ScopeBuilder.tsx");

describe("the editor and the preview read the same fields", () => {
  it("builds the campaign's AST from the shared reading, not from a literal", () => {
    // A literal array here is how the two drift: it looks identical on the day it is
    // written and nobody updates both. Since the filter builder (#817) the shared reading is
    // `scopeFrom`, which reads the builder's field and the fields before it.
    expect(EDITOR).toContain("const scope = scopeFrom(read);");
    expect(DRAFT_INPUT).toContain("const scope = scopeFrom(read);");
    expect(
      EDITOR,
      "a hand-written field list in the action is how the preview and the run stop agreeing",
    ).not.toMatch(/for \(const field of \[/);
  });

  it("renders the builder whose fields that reading accepts", () => {
    // The builder offers `BUILDER_FIELDS`, and `decodeScope` keeps only those: a condition the
    // form can set is one the reading keeps.
    expect(EDITOR).toContain("<ScopeBuilder");
    expect(BUILDER).toContain("BUILDER_FIELDS.map(");
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
   * Since #817 these are the fields a link from before the filter builder carries, which
   * `scopeFrom` still reads; the builder's own list is pinned in `scope-builder.test.ts`.
   */
  const EXPECTED = ["collection", "excludeTag", "tag", "title", "vendor"];

  it("reads exactly the conditions a link from before the builder carries", () => {
    expect([...SCOPE_CONDITION_FIELDS].sort()).toEqual(EXPECTED);
    // Each of them is one the builder offers too, so a scope opened from such a link can be edited.
    for (const field of EXPECTED) expect(BUILDER_FIELDS as readonly string[]).toContain(field);
  });

  it("has a control in the builder for every field it offers", () => {
    // A field nothing renders is a scope a merchant cannot reach. Each field takes its value
    // by kind, and each kind's branch renders a Polaris control.
    for (const field of BUILDER_FIELDS) {
      const kind = FIELD_SPECS[field].input.kind;
      expect(BUILDER, `no control for ${field} (${kind})`).toMatch(new RegExp(`case "${kind}":[\\s\\S]*?<s-(?:select|text-field|number-field)`));
    }
  });
});

describe("the draft and archived boxes (#751)", () => {
  it("renders a box for every status the reader knows", () => {
    // A status the reader accepts and nothing renders is an opt-in no merchant can reach.
    for (const field of Object.keys(PRODUCT_STATUS_FIELDS)) {
      expect(EDITOR, `no checkbox named ${field}`).toMatch(new RegExp(`<s-checkbox[^>]*?name="${field}"`));
    }
  });

  it("creates the campaign from the reader the preview uses", () => {
    // `draftCampaignFrom` reads them through `productStatusesFrom`; the action reading the
    // form any other way is a box the preview prices and the campaign forgets.
    expect(EDITOR).toContain("productStatuses: productStatusesFrom(read)");
  });
});
