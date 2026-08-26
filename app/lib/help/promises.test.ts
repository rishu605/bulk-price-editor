/**
 * The help centre does not promise things the app cannot do.
 *
 * A dead link was the last version of this problem and it got fixed. This is the worse
 * version: a page that loads perfectly and describes a feature that is not there. The
 * Flow page told merchants "Anchor adds three triggers and three actions to Flow" while
 * `extensions/` held no manifests, so Flow showed nothing. A merchant following it would
 * search, find nothing, and conclude the app is broken — which is a support ticket and a
 * one-star review, not a missing feature.
 *
 * Flow is released as of app version `bulk-price-editor-8`, so the page describes
 * something a merchant can actually set up and the "not available yet" notice is gone.
 *
 * What remains worth asserting is the pair that made the notice necessary in the first
 * place: the page describes triggers and actions, and the extensions that declare them to
 * Shopify exist. Delete the extensions and the page becomes a promise again — which is
 * the state this test was written to catch.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const NOTICE = "Not available yet";

/** Extension manifests, which is what actually puts triggers and actions in Flow. */
function manifests(): string[] {
  const dir = join(ROOT, "extensions");
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "shopify.extension.toml"))
    .filter((file) => existsSync(file));
}

describe("Shopify Flow", () => {
  const doc = readFileSync(join(ROOT, "docs/help/how-to/shopify-flow.md"), "utf8");
  const index = readFileSync(join(ROOT, "docs/help/index.md"), "utf8");
  it("has an extension for everything the page describes", () => {
    // Six: three triggers and three actions. Fewer means the page promises something
    // Shopify was never told about, which is how it read before the release.
    expect(manifests().length, "the Flow extension manifests are gone").toBe(6);
  });

  it("no longer warns that it is unavailable, because it is not", () => {
    expect(doc).not.toContain(NOTICE);
  });

  it("does not warn on the index either", () => {
    const line = index.split("\n").find((row) => row.includes("shopify-flow.md")) ?? "";

    expect(line).not.toMatch(/not available/i);
  });

});
