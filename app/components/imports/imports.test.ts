/**
 * Everything the Imports section did, and where it does it now.
 *
 * "Imports" was a nav item named after a verb. Two of its five tabs — Baselines and Costs
 * — were nouns that already had a tab of their own under Prices, so the sidebar asked a
 * merchant to choose between two right answers to "where do I set costs"; the page that
 * listed costs even carried a button across the nav boundary to a page with the same
 * name. And the fifth, importing prices, said in its own first line that it does not set
 * prices at all — it creates a campaign.
 *
 * So it was dissolved into the nouns it acts on. **Dissolving is where functionality goes
 * missing**, and it goes missing quietly: nothing 404s, no test fails, a flow is simply
 * no longer reachable and nobody notices until a merchant asks. This file is the
 * inventory that prevents that. Every capability the section had is listed with the file
 * that now provides it, and every one is checked two ways — the service is still called,
 * and there is still a way to reach the page that calls it without typing a URL.
 *
 * The safety properties are checked hardest, because they are the ones whose absence
 * looks like nothing at all: a dry run that quietly became a commit, and a recapture that
 * lost its typed confirmation, are each a way to destroy a merchant's baselines that no
 * screenshot would show.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** Source with its own commentary removed, so a file explaining its history is not read as doing it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PRICE_IMPORT = read("app/routes/app.campaigns.import.tsx");
const BASELINES = read("app/routes/app.prices.baselines._index.tsx");
const COSTS = read("app/routes/app.prices.costs.tsx");
const RECAPTURE = read("app/routes/app.prices.baselines.recapture.tsx");
const CAMPAIGNS = read("app/routes/app.campaigns._index.tsx");
const NAV = read("app/routes/app.tsx");
const IMPORT_FORM = read("app/components/imports/ImportForm.tsx");
const DROP_ZONE = read("app/components/imports/CsvDropZone.tsx");

describe("the nav is four items, and none of them is a verb", () => {
  it("no longer offers Imports", () => {
    expect(code(NAV)).not.toContain("/app/imports");
  });

  it("keeps the four nouns", () => {
    const items = [...code(NAV).matchAll(/<s-link href="(\/app[^"]*)"/g)].map((m) => m[1]);
    expect(items).toEqual(["/app", "/app/campaigns", "/app/prices", "/app/settings"]);
  });

  it("stops naming Baselines and Costs twice", () => {
    // The collision that made this worth doing: each was a tab under Prices *and* a tab
    // under Imports, meaning "look at them" in one place and "replace them" in the other.
    const prices = read("app/routes/app.prices.tsx");
    for (const noun of ["Baselines", "Costs"]) {
      const tabs = [...code(prices).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
      expect(tabs.filter((label) => label === noun)).toHaveLength(1);
    }
  });
});

describe("every capability the Imports section had still exists", () => {
  it("imports prices, and still makes a campaign rather than writing prices", () => {
    // The whole argument for routing an import through a campaign: it gets a preview,
    // guardrails, rounding, market surfaces and a revert, none of which a direct write
    // would have had.
    expect(PRICE_IMPORT).toContain("importPrices(");
    expect(PRICE_IMPORT).toContain("createCampaign(");
    expect(PRICE_IMPORT).toContain("redirect(`/app/campaigns/${campaign.id}`)");
  });

  it("still lists the price files a shop has imported", () => {
    // `price_imports` was written since the feature shipped and read by nothing until
    // #351. Losing the page again in a restructure would put it back the way it was.
    expect(PRICE_IMPORT).toContain("prisma.priceImport.findMany");
    expect(PRICE_IMPORT).toContain("Price files you have imported");
  });

  it("imports baselines, on the page that lists baselines", () => {
    expect(BASELINES).toContain("importBaselines(");
  });

  it("imports costs, on the page that lists costs", () => {
    expect(COSTS).toContain("importCosts(");
  });

  it("recaptures baselines, with the scope assessment intact", () => {
    expect(RECAPTURE).toContain("planRecapture(");
    expect(RECAPTURE).toContain("recapture(");
  });

  it("still offers the error CSV for both imports that had one", () => {
    expect(BASELINES).toContain("importErrorCsv");
    expect(COSTS).toContain("costErrorCsv");
  });
});

describe("every one of them is reachable without typing a URL", () => {
  it("the price import is offered on the campaigns index", () => {
    expect(CAMPAIGNS).toContain('href="/app/campaigns/import"');
    expect(CAMPAIGNS).toContain("From a spreadsheet");
  });

  it("the baseline and cost imports are on the tabs that own those nouns", () => {
    // Not linked to — rendered there. A section on the page cannot be orphaned by a
    // link somebody forgets to update.
    expect(BASELINES).toContain("<ImportForm");
    expect(COSTS).toContain("<ImportForm");
  });

  it("recapture is linked from the baselines page it rewrites", () => {
    expect(BASELINES).toContain('href="/app/prices/baselines/recapture"');
  });

  it("recapture's tab still lights up while you are on it", () => {
    // `SectionTabs` matches the current path exactly, so a page beneath a tab used to
    // leave the bar with nothing selected — which is what `/app/imports` did, and there
    // was no way back from it.
    const tabs = read("app/components/SectionTabs.tsx");
    expect(tabs).toContain("export function isCurrent");
  });
});

describe("the safety properties travelled with the flows", () => {
  it("dry run is still the default, and is one function rather than three literals", () => {
    // `isCommit` is exercised against the values that actually arrive in
    // `app/lib/imports/intent.test.ts`. What is checked here is that every import path
    // goes through it, rather than reintroducing its own comparison.
    for (const [name, source] of [
      ["price import", PRICE_IMPORT],
      ["baseline import", BASELINES],
      ["cost import", COSTS],
    ] as const) {
      expect(code(source), `${name} decides commit-or-check for itself`).toContain("isCommit(");
      expect(code(source), `${name} spells out its own comparison`).not.toMatch(
        /String\(form\.get\("intent"\)\) !== "commit"/,
      );
    }
  });

  it("the cost page's two check-then-commit flows cannot trigger each other", () => {
    // Importing costs and bulk-editing costs now share a route. One `intent` field
    // cannot mean two things, and if it did, pressing "Change these costs" would write a
    // file instead.
    expect(COSTS).toContain('IMPORT_INTENT = { check: "import-dry-run", commit: "import-commit" }');
    expect(COSTS).toContain("isCommit(intent, IMPORT_INTENT.commit)");
  });

  it("recapture still demands a typed confirmation phrase", () => {
    // The one action that can destroy the guarantee the whole product rests on. Moving
    // it must not have moved it one click closer.
    expect(RECAPTURE).toMatch(/confirmationPhrase/);
    expect(RECAPTURE).toContain('name="confirmation"');
  });

  it("recapture still warns about the campaigns it would disturb", () => {
    expect(RECAPTURE).toMatch(/overlap/i);
  });

  it("recapture is still a page of its own, not a button on a list", () => {
    // Its own doc comment argued for that, and `planRecapture` counts a scope of up to
    // half a million variants — not something to run on every visit to a page a merchant
    // opens to look one price up.
    expect(code(BASELINES)).not.toContain("planRecapture");
  });
});

describe("dropping a file", () => {
  it("the shared form offers a drop zone and keeps the textarea", () => {
    expect(IMPORT_FORM).toContain("<CsvDropZone");
    // The textarea stays: a merchant fixing three rows after a failed dry run needs it,
    // and it is still what the form submits.
    expect(IMPORT_FORM).toContain('name="csv"');
  });

  it.each([
    ["prices", PRICE_IMPORT],
    ["baselines", BASELINES],
    ["costs", COSTS],
  ])("%s accepts a file as well as pasted text", (_name, source) => {
    expect(source).toContain("<ImportForm");
  });

  it("tells the Polaris field its value changed", () => {
    // Assigning to `.value` alone leaves the component's own state stale, so the box
    // looks full and the server receives it empty — the worst possible failure here,
    // because the merchant watched the file load.
    expect(DROP_ZONE).toContain('new Event("input"');
    expect(DROP_ZONE).toContain('new Event("change"');
  });

  it("says nothing is imported until the merchant runs it", () => {
    expect(DROP_ZONE).toMatch(/Nothing is imported until you run it/);
  });

  it("explains itself when the file cannot be read, rather than doing nothing", () => {
    expect(DROP_ZONE).toMatch(/paste its contents instead/i);
  });
});

describe("the three imports are one import", () => {
  it("blocks the commit until a dry run has found rows", () => {
    expect(IMPORT_FORM).toMatch(/disabled=\{!ready \|\| undefined\}/);
  });

  it("marks the commit as the consequential one on every source", () => {
    expect(IMPORT_FORM).toContain('tone="critical"');
  });

  it.each([
    ["prices", PRICE_IMPORT],
    ["baselines", BASELINES],
    ["costs", COSTS],
  ])("%s carries no copy of the form", (_name, source) => {
    // Its own CSV field or drop zone, specifically. The costs page keeps a `submitWith`
    // of its own and should: that is the bulk cost editor, which is a different form on
    // the same page and was never part of the import.
    expect(source).not.toContain('name="csv"');
    expect(source).not.toContain("<CsvDropZone");
  });

  it.each([
    ["prices", PRICE_IMPORT],
    ["baselines", BASELINES],
    ["costs", COSTS],
  ])("%s reports its counts as figures rather than a sentence", (_name, source) => {
    expect(source).toContain("<ImportReport");
  });

  it("shows problem rows as a table, not a bullet list", () => {
    expect(IMPORT_FORM).toContain("<s-table");
    expect(IMPORT_FORM).not.toContain("<s-unordered-list");
  });

  it("says how many rows were left out of the table it truncates", () => {
    expect(IMPORT_FORM).toMatch(/Showing the first \{limit\} of \{problems\.length\}/);
  });
});

describe("making a segment is one decision", () => {
  const segments = code(read("app/routes/app.settings.segments.tsx"));

  it("offers one create form, not two competing cards", () => {
    expect(segments).not.toContain("New segment from a filter");
    expect(segments).not.toContain("New segment from a list");
    expect(segments).toContain('heading="New segment"');
  });

  it("has one black button on the page", () => {
    expect((segments.match(/variant="primary"/g) ?? []).length).toBe(1);
  });

  it("asks how the products are named, which is the only thing that differed", () => {
    expect(segments).toContain("<s-choice-list");
    expect(segments).toContain('<s-choice value="filter"');
    expect(segments).toContain('<s-choice value="list"');
  });

  it("sends the intent that matches the choice", () => {
    expect(segments).toMatch(/how === "filter" \? "create-filter" : "create-from-csv"/);
  });
});
