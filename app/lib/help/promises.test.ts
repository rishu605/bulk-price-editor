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
 * The notice used to be tied to the extension manifests existing. That was a proxy for
 * "a merchant can use this", and once the manifests were written it became visibly too
 * loose: an extension in the repo is not an extension in a merchant's Flow. The real gate
 * is a release, which a test cannot see.
 *
 * So the rule is weaker and honest: while the page says it is unavailable, it must also
 * say what is missing, and it must not describe the integration in the present tense.
 * Removing the notice is a deliberate act somebody performs when Flow actually works,
 * and the manifests' existence no longer forces it.
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
  it("says plainly that it is not available", () => {
    // Until somebody removes this deliberately, the page must not read as instructions.
    expect(doc).toContain(NOTICE);
  });

  it("names what is actually missing, not just that something is", () => {
    // "Not available yet" with no reason invites a merchant to go looking for a setting.
    expect(doc).toMatch(/has not been released|not been released/);
  });

  it("has the extensions that a release would publish", () => {
    // The half that *is* done. If these disappear, the page is describing nothing at all.
    expect(manifests().length, "the Flow extension manifests are gone").toBeGreaterThan(0);
  });

  it("does not describe it in the present tense while it is unavailable", () => {
    // "Anchor adds three triggers" reads as a statement of fact about today.
    expect(doc).not.toMatch(/^Anchor adds /m);
  });

  it("warns on the index too, where merchants choose what to read", () => {
    const line = index.split("\n").find((row) => row.includes("shopify-flow.md")) ?? "";

    expect(line, "the index links to Flow with no hint that it is unavailable").toMatch(
      /not available yet/i,
    );
  });
});
