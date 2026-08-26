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
 * Tying the notice to the manifests means the doc cannot drift in either direction: ship
 * the extension without updating the page and this fails; remove the extension without
 * restoring the notice and it fails too.
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
  const shipped = manifests().length > 0;

  it("says whether it is available, matching whether it actually is", () => {
    if (shipped) {
      expect(
        doc,
        "Flow extensions exist now, so the help page should stop saying it is unavailable.",
      ).not.toContain(NOTICE);
    } else {
      expect(
        doc,
        "There are no Flow extension manifests, so the help page must not describe Flow " +
          "as something a merchant can set up today.",
      ).toContain(NOTICE);
    }
  });

  it("does not describe it in the present tense while it is unavailable", () => {
    if (shipped) return;

    // "Anchor adds three triggers" reads as a statement of fact about today.
    expect(doc).not.toMatch(/^Anchor adds /m);
  });

  it("warns on the index too, where merchants choose what to read", () => {
    if (shipped) return;

    const line = index.split("\n").find((row) => row.includes("shopify-flow.md")) ?? "";

    expect(line, "the index links to Flow with no hint that it is unavailable").toMatch(
      /not available yet/i,
    );
  });
});
