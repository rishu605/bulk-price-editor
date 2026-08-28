/**
 * The import section's guarantees.
 *
 * Two of these are safety properties rather than layout: a dry run that stopped being
 * the default, or a recapture that lost its typed confirmation, would each be a quiet
 * way to destroy a merchant's baselines — and neither would look wrong in a screenshot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const routes = ["prices", "baselines", "costs"] as const;
const source = (name: string) =>
  readFileSync(join(process.cwd(), "app", "routes", `app.imports.${name}.tsx`), "utf8");
const dropZone = readFileSync(
  join(process.cwd(), "app", "components", "imports", "CsvDropZone.tsx"),
  "utf8",
);
const importForm = readFileSync(
  join(process.cwd(), "app", "components", "imports", "ImportForm.tsx"),
  "utf8",
);

describe("dry run stays the default", () => {
  it.each(routes)("%s commits only when explicitly asked", (name) => {
    // `!== "commit"` rather than `=== "dryRun"`: an intent that fails to arrive, or
    // arrives misspelled, must fall to the safe side.
    expect(source(name)).toContain('!== "commit"');
  });
});

describe("recapture keeps its guard", () => {
  const recapture = source("recapture");

  it("still demands a typed confirmation phrase", () => {
    // Recapture re-anchors baselines. It is the one action that can destroy the
    // guarantee the whole product rests on, and consolidating the UI must not have
    // moved it one click closer.
    expect(recapture).toMatch(/confirmationPhrase|confirm/i);
  });

  it("still warns about campaigns it would disturb", () => {
    expect(recapture).toMatch(/overlap/i);
  });
});

describe("dropping a file", () => {
  // The three routes rendered their own drop zone and textarea until they were collapsed
  // onto one `ImportForm`. Checking the route source for `<CsvDropZone` stopped meaning
  // anything at that point — so the guarantee is checked where it now lives, plus that
  // each route actually goes through the thing that provides it. Two assertions instead
  // of one, and neither can pass while the merchant has no way to drop a file.
  it("the shared form offers a drop zone and keeps the textarea", () => {
    expect(importForm).toContain("<CsvDropZone");
    // The textarea stays: a merchant fixing three rows after a failed dry run needs it,
    // and it is still what the form submits.
    expect(importForm).toContain('name="csv"');
  });

  it.each(routes)("%s accepts a file as well as pasted text", (name) => {
    expect(source(name)).toContain("<ImportForm");
  });

  it("tells the Polaris field its value changed", () => {
    // Assigning to `.value` alone leaves the component's own state stale, so the box
    // looks full and the server receives it empty — the worst possible failure here,
    // because the merchant watched the file load.
    expect(dropZone).toContain('new Event("input"');
    expect(dropZone).toContain('new Event("change"');
  });

  it("says nothing is imported until the merchant runs it", () => {
    expect(dropZone).toMatch(/Nothing is imported until you run it/);
  });

  it("explains itself when the file cannot be read, rather than doing nothing", () => {
    expect(dropZone).toMatch(/paste its contents instead/i);
  });
});

describe("the three imports are one import", () => {
  /**
   * The guard that existed on one of three paths.
   *
   * "You cannot commit before you have checked" was implemented in `app.imports.baselines`
   * and nowhere else, and nothing in the other two said they were different on purpose.
   * It lives in `ImportForm` now, which is what makes it true on all three at once — and
   * what makes it impossible to lose from one of them.
   */
  it("blocks the commit until a dry run has found rows", () => {
    expect(importForm).toMatch(/disabled=\{!ready \|\| undefined\}/);
  });

  it("still defaults to a dry run, so a missing intent falls safe", () => {
    expect(importForm).toMatch(/name="intent"[\s\S]{0,80}value="dry-run"/);
  });

  it("marks the commit as the consequential one on every source", () => {
    // Prices had a plain secondary button for the action that creates a campaign over a
    // merchant's catalogue, while the other two used `tone="critical"`.
    expect(importForm).toContain('tone="critical"');
  });

  it.each(routes)("%s no longer carries its own copy of the form", (name) => {
    const s = source(name);

    expect(s).not.toContain("<s-text-area");
    expect(s).not.toContain("submitWith");
    expect(s).not.toContain('<input type="hidden" name="intent"');
  });

  it.each(routes)("%s reports its counts as figures rather than a sentence", (name) => {
    // Prices showed none at all; the other two ran four and five numbers together into
    // one line of prose. `CountsRow` is how the campaign preview shows the same thing.
    expect(source(name)).toContain("<ImportReport");
  });

  it("shows problem rows as a table, not a bullet list", () => {
    // Two of the three used a list, which puts the line, the identifier and the reason
    // into one sentence per row — so nothing lines up, and twenty bad rows cannot be
    // scanned for the thing they have in common.
    expect(importForm).toContain("<s-table");
    expect(importForm).not.toContain("<s-unordered-list");
  });

  it("says how many rows were left out of the table it truncates", () => {
    // A silent top-25 reads as "these are all of them".
    expect(importForm).toMatch(/Showing the first \{limit\} of \{problems\.length\}/);
  });
});

/**
 * Source with its comments taken out.
 *
 * The repo has been caught by this before — the compliance check that rejects a native
 * form element greps for `<form`, so the *word* in a comment trips it. The same thing
 * happened here on the first run: the doc comment explaining why the two segment cards
 * were merged quotes both of their old headings and the `variant="primary"` they each
 * carried, so a check for "those headings are gone" failed on the note saying they had
 * gone.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("making a segment is one decision", () => {
  const segments = code(
    readFileSync(join(process.cwd(), "app", "routes", "app.settings.segments.tsx"), "utf8"),
  );

  it("offers one create form, not two competing cards", () => {
    expect(segments).not.toContain("New segment from a filter");
    expect(segments).not.toContain("New segment from a list");
    expect(segments).toContain('heading="New segment"');
  });

  it("has one black button on the page", () => {
    // Two sibling cards each ending in a primary button is the two-black-buttons failure
    // spread thin enough that neither card broke the rule on its own.
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
