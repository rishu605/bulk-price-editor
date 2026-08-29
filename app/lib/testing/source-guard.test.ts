/**
 * No test reads this app's source without stripping its commentary first.
 *
 * The rule the helper exists for, enforced. Seven times a check here has fired on a
 * comment explaining the very string it greps for; each time the fix was two lines
 * pasted into one more file, and each new source-level test started the count again.
 *
 * The check is narrow on purpose. Plenty of tests read files legitimately — a migration,
 * a manifest, a JSON schema, this repo's own `package.json` — and none of them are the
 * trap. Only reading a `.ts` or `.tsx` file is, because that is the only kind of file
 * whose comments are written in the same words as its code.
 */

import { describe, expect, it } from "vitest";

import { rawSource, testFiles } from "./source";

/**
 * Reading a file through `node:fs` inside a test.
 *
 * Deliberately not "reading a path that ends in `.ts`". The first version of this rule
 * matched only literal filenames, and a reverted call site sailed through it because the
 * path was a variable from a directory walk — which is the shape most of these checks
 * have. Any read is caught, and the exemptions below say which ones are not source.
 */
const READS_A_FILE = /\breadFileSync\s*\(/;

/** Any of the helper's exports being imported from this directory. */
const USES_HELPER = /from "[^"]*testing\/source"/;

/**
 * Tests that read source and mean to see the comments.
 *
 * `source.test.ts` is the helper's own, and half its assertions are about what survives.
 * Anything else added here needs a reason in this list, not a comment at the call site —
 * a per-file exemption nobody has to justify centrally is how the rule erodes.
 */
const READS_SOMETHING_ELSE: Record<string, string> = {
  "app/lib/testing/source.test.ts": "the helper's own test, which checks what it strips",
  "app/lib/billing/listing-parity.test.ts": "the App Store listing, which is markdown",
  "app/lib/compliance/built-for-shopify.test.ts": "shopify.app.toml and the criteria sheet",
  "app/lib/compliance/deploy-config.test.ts": "shopify.app.toml and the deployment workflow",
  "app/lib/errors/help-links.contract.test.ts": "the help centre's markdown pages",
  "app/lib/help/nav.server.test.ts": "the help centre's markdown pages",
  "app/lib/help/promises.test.ts": "the help centre's markdown pages",
  "app/lib/help/search.server.test.ts": "the help centre's markdown pages",
  "app/lib/observability/alerts.test.ts": "the alert rules, which are YAML",
  "app/lib/observability/metrics-contract.test.ts": "the runbook, which is markdown",
  "app/lib/observability/runbook-coverage.test.ts": "the runbook, which is markdown",
  "app/lib/format/label.test.ts": "the humanise fixtures, which are JSON",
  "app/lib/ui/spacing.test.ts": "the design tokens, which are JSON",
  "app/lib/flow/manifest.test.ts": "the Flow manifests, which are JSON",
  "app/lib/ui/settings-form.test.ts": "the settings schema, which is JSON",
  "app/lib/catalog/sync-parity.test.ts": "the GraphQL documents",
  "app/lib/shopify/scope-probe.test.ts": "shopify.app.toml",
  "app/components/campaign/sections.test.ts": "measures the route as written, comments included",
  "app/worker/queue-runtime.test.ts": "the Dockerfile and the process manifest",
};

describe("every source-level check goes through the helper", () => {
  const tests = testFiles("app").map((path) => ({ path, source: rawSource(path) }));

  it("finds the source-level checks it is protecting", () => {
    // A floor, so this file cannot quietly pass by finding nothing — the failure mode of
    // every census check, and the reason the ones in this repo carry a number. Counting
    // helper *users* rather than raw readers, because the whole point is that there are
    // no raw readers left: a floor on those would now be a floor on zero.
    const readers = tests.filter(({ source }) => USES_HELPER.test(source));

    expect(readers.length).toBeGreaterThanOrEqual(20);
  });

  it("refuses a raw read of a .ts or .tsx file", () => {
    // Not "unless the file also imports the helper". A file that uses `sourceOf` in
    // eight places and `readFileSync` in the ninth is the exact shape this rule is for,
    // and an import-based exemption would wave it through — which it did, until a
    // deliberately reverted call site passed.
    const offenders = tests
      .filter(({ path }) => !(path in READS_SOMETHING_ELSE))
      .filter(({ source }) => READS_A_FILE.test(source))
      .map(({ path }) => path);

    expect(
      offenders,
      "use sourceOf/withoutComments from app/lib/testing/source — a comment naming the " +
        "string being grepped for must not satisfy the grep",
    ).toEqual([]);
  });
});
