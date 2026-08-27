/**
 * The help centre, checked against the errors that link into it and against itself.
 *
 * `HELP_PATHS` is a `Record<ErrorCode, string>`, so a new error code will not compile
 * until somebody has decided where to send the merchant. What nothing checked is whether
 * the page at the other end exists — rename a file and every error screen for that code
 * links to a 404, at the moment a merchant is already having a bad time. A broken link
 * under an error message is worse than no link, because it confirms the suspicion that
 * nobody is looking after this.
 *
 * The orphan check is the other direction. Two real pages — `form-validation` and
 * `missing-record` — were reachable only from an error screen and from nowhere in the
 * help centre itself, so a merchant browsing for them could not find them. A help page
 * nobody can navigate to is a help page that only exists for the person who already knew
 * the URL.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, normalize, dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { helpPathOf } from "./help-links";
import type { ErrorCode } from "./app-error";

const ROOT = process.cwd();
const HELP = join(ROOT, "docs/help");

const CODES: ErrorCode[] = [
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
];

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, found);
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

/** Every relative link target in a page, resolved against the page's own directory. */
function linksFrom(file: string): Array<{ raw: string; resolved: string }> {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/\]\(([^)#]+)\)/g)]
    .map(([, raw]) => raw)
    .filter((raw) => !/^(https?:|mailto:)/.test(raw))
    .map((raw) => ({ raw, resolved: normalize(join(dirname(file), raw)) }));
}

describe("every error sends the merchant to a page that exists", () => {
  it.each(CODES)("%s", (code) => {
    const path = helpPathOf(code);
    expect(path.startsWith("/"), `${code} maps to "${path}", which is not root-relative`).toBe(
      true,
    );

    const file = join(HELP, `${path}.md`);
    expect(
      existsSync(file),
      `${code} links to ${path}, and docs/help${path}.md does not exist — the merchant ` +
        `gets a 404 from an error screen`,
    ).toBe(true);
  });

  it("sends an unrecognised code somewhere real rather than to undefined", () => {
    // The code crosses a serialisation boundary as a plain string, so this is reachable.
    expect(existsSync(join(HELP, `${helpPathOf("NOT_A_REAL_CODE")}.md`))).toBe(true);
  });
});

describe("the help centre links to itself correctly", () => {
  const pages = markdownFiles(HELP);

  it("found the pages", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it.each(pages.map((page) => [page.slice(ROOT.length + 1), page] as const))(
    "%s",
    (_label, page) => {
      for (const link of linksFrom(page)) {
        expect(
          existsSync(link.resolved),
          `${page.slice(ROOT.length + 1)} links to "${link.raw}", which does not exist`,
        ).toBe(true);
      }
    },
  );

  it("has no page a reader cannot navigate to", () => {
    const linked = new Set(pages.flatMap((page) => linksFrom(page).map((l) => l.resolved)));
    const index = normalize(join(HELP, "index.md"));

    const orphans = pages
      // `images/README.md` is a note to whoever adds a screenshot, not a help page.
      .filter((page) => !page.includes(`${normalize("/images/")}`))
      .filter((page) => page !== index)
      .filter((page) => !linked.has(page))
      .map((page) => page.slice(ROOT.length + 1));

    expect(
      orphans,
      `these pages are reachable only by knowing the URL: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});
