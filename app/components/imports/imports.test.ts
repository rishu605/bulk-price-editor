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
  it.each(routes)("%s accepts a file as well as pasted text", (name) => {
    const s = source(name);
    expect(s).toContain("<CsvDropZone");
    // The textarea stays: a merchant fixing three rows after a failed dry run needs it,
    // and it is still what the form submits.
    expect(s).toContain('name="csv"');
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
