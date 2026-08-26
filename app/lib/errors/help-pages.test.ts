/**
 * The pages the app links to actually exist.
 *
 * Without this, the error-to-doc mapping and the docs drift apart silently: somebody
 * renames a page, the link still compiles, and a merchant hitting an error at 9pm gets a
 * 404 under the message telling them what went wrong. A broken link there is worse than
 * no link, because it confirms nobody is looking after this.
 */

import { describe, expect, it } from "vitest";

import { readHelpPage } from "../help/pages.server";
import { helpUrlFor, HELP_BASE } from "./help-links.server";

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

/**
 * The slug the route would receive for a published help URL.
 *
 * Asking the server what it would serve, rather than rebuilding the file path here. The
 * two used to be able to disagree: the mapping could name a real file that the route
 * refused anyway — a slug the path check rejects reads as a missing page to the merchant
 * no matter how present the file is.
 */
function slugFor(url: string): string {
  expect(url.startsWith(HELP_BASE), `${url} is not under ${HELP_BASE}`).toBe(true);
  return url.slice(HELP_BASE.length).replace(/^\//, "");
}

describe("every error links to a page the app will serve", () => {
  it.each(CODES)("%s", async (code) => {
    const url = helpUrlFor(code);
    const page = await readHelpPage(slugFor(url));

    expect(page, `${code} links to ${url}, which the help centre will not serve`).not.toBeNull();
  });

  it("sends an unrecognised code somewhere real too", async () => {
    expect(await readHelpPage(slugFor(helpUrlFor("NOT_A_REAL_CODE")))).not.toBeNull();
  });
});
