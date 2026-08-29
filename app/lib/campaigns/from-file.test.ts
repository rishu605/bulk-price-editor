/**
 * A spreadsheet is a way prices change, not a different door.
 *
 * The campaigns index had two buttons — "Create campaign" and "From a spreadsheet" — so a
 * merchant had to know which of their two intentions the app had filed their case under
 * before they could start, to make the same object either way. We had already learned
 * this once: #416 dissolved the Imports nav item on the rule that a nav item is a noun,
 * and the page surviving as a button was the same mistake one size smaller.
 *
 * What must not move is the safety. The two-phase dry-run-then-commit, the parsing and
 * the per-row reporting are the reason writing prices from a file is survivable, so the
 * editor posts to the same action rather than growing its own.
 */

import { describe, expect, it } from "vitest";

import { FROM_FILE } from "../../components/RuleValueField";
import { LEGACY_ROUTES } from "../routing/legacy-routes";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
const FIELD = sourceOf("app/components/RuleValueField.tsx");
const RESOURCE = sourceOf("app/routes/app.price-import.tsx");

describe("the choice", () => {
  it("offers a file among the ways prices change", () => {
    expect(FIELD).toContain("<s-option value={FROM_FILE}");
    expect(FIELD).toContain("How should prices change?");
  });

  it("is a named constant, not a string spelled out at each branch", () => {
    // It decides whether a scope section renders. A typo would produce a page that keeps
    // the wrong half and looks deliberate.
    expect(FROM_FILE).toBe("from-file");
  });
});

describe("choosing it", () => {
  it("removes the scope rather than leaving it inert", () => {
    // The acceptance criterion, and the reason the second page was confusing: a file
    // names its own variants, so a scope a merchant fills in would be discarded.
    expect(EDITOR).toMatch(/\{fromFile \? null : \(\s*<s-section heading=\{headings\.scope\}/);
  });

  it("removes the arithmetic controls too", () => {
    // Same argument. Compare-at, rounding, markets, schedule and priority are all things
    // the import's own flow does not read.
    expect(EDITOR).toContain("{fromFile ? null : (");
    expect(EDITOR).toContain("{!fromFile && priceLists.length > 0 ?");
  });

  it("shows the option it is actually on", () => {
    // The default used to be pinned to the first option, so a link carrying
    // `?ruleKind=from-file` produced a page with no scope and a file section whose select
    // still read "Percent change from baseline". A control that disagrees with the page
    // it controls is worse than either state — the merchant cannot tell which is lying.
    expect(FIELD).toContain("defaultSelected={kind === FROM_FILE}");
    expect(FIELD, "the first option must not be selected regardless of the kind").not.toMatch(
      /<s-option[^>]*value=\{DRAFT_DEFAULTS\.ruleKind\} defaultSelected>/,
    );
  });

  it("hides the rule preview, which would be pricing a rule that is not there", () => {
    // The panel prices the draft's arithmetic. With a file chosen there is none, so it
    // renders whatever the controls said before the merchant switched — "3,669 of 3,669
    // variants would change price" beside a form that will do nothing of the kind.
    expect(EDITOR).toContain('{fromFile ? null : (\n      <s-section slot="aside"');
  });

  it("shows the file, the history and a template", () => {
    expect(EDITOR).toContain("<ImportForm");
    expect(EDITOR).toContain("<PriceImportHistory");
    expect(EDITOR).toContain("Get a template");
  });
});

describe("the safety did not move", () => {
  it("posts to the import's own action rather than to the editor's", () => {
    // The editor's action creates a campaign from a rule. A second submit target on one
    // route is a misrouted request away from creating the wrong thing — the argument
    // `app.preview-draft.tsx` already makes about its own resource route.
    expect(EDITOR).toContain('action="/app/price-import"');
  });

  it("still falls safe on a missing intent", () => {
    // `isCommit` is exercised in `app/lib/imports/intent.test.ts`. What matters here is
    // that this path still goes through it rather than growing its own comparison.
    expect(RESOURCE).toContain("const dryRun = !isCommit(form.get(\"intent\"));");
    expect(RESOURCE).not.toMatch(/String\(form\.get\("intent"\)\) !== "commit"/);
  });

  it("still creates a campaign rather than writing prices", () => {
    expect(RESOURCE).toContain("createCampaign(");
    expect(RESOURCE).toContain("redirect(`/app/campaigns/${campaign.id}`)");
  });
});

describe("the URLs that used to lead here", () => {
  it("all point at the editor, opened on the file", () => {
    for (const old of [
      "/app/campaigns/import",
      "/app/imports",
      "/app/imports/prices",
      "/app/prices/import",
    ]) {
      expect(LEGACY_ROUTES[old], `${old} should open the editor on the file`).toContain(
        `ruleKind=${FROM_FILE}`,
      );
    }
  });

  it("opens on the file when the URL says so", () => {
    // A merchant following an old bookmark lands on the file, not on a percentage.
    expect(EDITOR).toContain('url.searchParams.get("ruleKind") === FROM_FILE');
  });
});
