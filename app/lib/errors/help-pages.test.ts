/**
 * The pages the app links to actually exist.
 *
 * Without this, the error-to-doc mapping and the docs drift apart silently: somebody
 * renames a page, the link still compiles, and a merchant hitting an error at 9pm gets a
 * 404 under the message telling them what went wrong. A broken link there is worse than
 * no link, because it confirms nobody is looking after this.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { helpUrlFor, HELP_BASE } from "./help-links";

const CODES = [
  "UNAUTHENTICATED",
  "NO_SESSION",
  "SHOPIFY_THROTTLED",
  "SHOPIFY_UNAVAILABLE",
  "SHOPIFY_REJECTED",
  "GUARDRAIL_BLOCKED",
  "NOT_FOUND",
  "VALIDATION",
  "DB_UNAVAILABLE",
  "UNKNOWN",
] as const;

/** The repo path a published help URL corresponds to. */
function sourceFor(url: string): string {
  const path = url.slice(HELP_BASE.length);
  return join(process.cwd(), "docs/help", `${path}.md`);
}

describe("every error links to a page that exists", () => {
  it.each(CODES)("%s", (code) => {
    const file = sourceFor(helpUrlFor(code));

    expect(existsSync(file), `${code} links to ${file}, which is not in the repo`).toBe(true);
  });
});
