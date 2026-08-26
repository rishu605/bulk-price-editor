/**
 * A search box that returns the wrong page is worse than no search box: it answers
 * confidently. These tests are about what a merchant would type, not about the scoring.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveHelpFile } from "./pages.server";
import { searchHelp, toProse } from "./search.server";

const HELP_ROOT = join(process.cwd(), "docs", "help");

const top = (query: string) => searchHelp(query)[0]?.slug;

describe("searching for the thing a page is about finds that page first", () => {
  const expectations: Array<[string, string]> = [
    ["drift", "concepts/drift"],
    ["baseline", "concepts/baselines"],
    ["revert", "concepts/revert"],
    ["rate limits", "concepts/rate-limits"],
    ["guardrail", "failures/guardrail-blocks"],
    ["flow", "how-to/shopify-flow"],
    ["first campaign", "how-to/first-campaign"],
  ];

  it.each(expectations)("%j → %s", (query, slug) => {
    expect(top(query)).toBe(slug);
  });
});

describe("what it refuses to do", () => {
  it("returns nothing for an empty query rather than every page", () => {
    // The index already lists everything; a search box that returns all of it looks like
    // it ignored what was typed.
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
    expect(searchHelp("!!")).toEqual([]);
  });

  it("narrows on a second word instead of widening", () => {
    const broad = searchHelp("campaign");
    const narrow = searchHelp("campaign schedule");

    expect(broad.length).toBeGreaterThan(narrow.length);
  });

  it("finds nothing for a word we never wrote", () => {
    expect(searchHelp("dropshipping")).toEqual([]);
  });

  it("never offers the index page as a result", () => {
    // It is the page you search from; listing it is noise.
    for (const query of ["help", "campaign", "price", "anchor"]) {
      expect(searchHelp(query, 50).map((h) => h.slug)).not.toContain("index");
    }
  });

  it("caps how many it returns", () => {
    expect(searchHelp("a price campaign", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("every result is usable", () => {
  // Every term must appear, so a long query narrows to nothing — "price" is what a
  // merchant actually types, and it reaches most of the centre.
  const hits = searchHelp("price", 50);

  it("found something to check", () => {
    expect(hits.length).toBeGreaterThan(5);
  });

  it("does not repeat the title as the opening of its own snippet", () => {
    for (const hit of hits) {
      expect(hit.snippet.startsWith(hit.title), hit.slug).toBe(false);
    }
  });

  it("links only to pages the help centre will serve", () => {
    for (const hit of hits) {
      expect(resolveHelpFile(hit.slug), `${hit.slug} is not servable`).not.toBeNull();
    }
  });

  it("shows prose, not markdown syntax", () => {
    for (const hit of hits) {
      // A snippet containing `](./foo.md)` or a heading's hashes reads as a bug.
      expect(hit.snippet, hit.slug).not.toMatch(/[[\]`|]|\]\(|^#/);
      expect(hit.snippet.length).toBeGreaterThan(20);
    }
  });

  it("points the highlight at the term that was actually searched", () => {
    for (const hit of searchHelp("drift", 50)) {
      if (!hit.match) continue;
      expect(hit.snippet.slice(hit.match.start, hit.match.end).toLowerCase()).toBe("drift");
    }
  });

  it("cuts snippets at word boundaries, not mid-word", () => {
    let trimmed = 0;

    for (const hit of hits) {
      const prose = toProse(readFileSync(join(HELP_ROOT, `${hit.slug}.md`), "utf8"));
      const body = hit.snippet.replace(/^…/, "").replace(/…$/, "");

      const at = prose.indexOf(body);
      expect(at, `${hit.slug}: snippet is not in the page`).toBeGreaterThanOrEqual(0);

      // The characters just outside the cut must be spaces, or the cut sat inside a word
      // and the merchant reads "…ign's prices are reverted".
      if (at > 0) {
        expect(prose[at - 1], `${hit.slug} starts mid-word`).toBe(" ");
        trimmed += 1;
      }
      const after = at + body.length;
      if (after < prose.length) {
        expect(prose[after], `${hit.slug} ends mid-word`).toBe(" ");
      }
    }

    expect(trimmed, "no snippet was trimmed, so this proves nothing").toBeGreaterThan(0);
  });

  it("gives a title that is the page's heading, not its slug", () => {
    for (const hit of hits) {
      expect(hit.title).not.toBe(hit.slug);
    }
  });
});

describe("markdown is reduced to the sentence a merchant read", () => {
  it("keeps a link's text and drops its target", () => {
    // The failure this prevents: searching "price" matching `](./prices.md)` and the
    // snippet showing markup.
    expect(toProse("See [how prices resolve](./concepts/resolver.md) first.")).toBe(
      "See how prices resolve first.",
    );
  });

  it("drops code blocks, which are syntax rather than prose", () => {
    expect(toProse("Before\n\n```sh\nnpm run apply --force\n```\n\nAfter")).toBe("Before After");
  });

  it("drops heading marks, emphasis and table pipes", () => {
    expect(toProse("## A heading\n\n**bold** and _thin_ and `code`")).toBe(
      "A heading bold and thin and code",
    );
    // Cells get a separator rather than being run together — without one, a table row
    // reads as corrupted text in a search result.
    expect(toProse("| Trigger | What it means |")).toBe("Trigger · What it means");
    expect(toProse("| A | B |\n|---|---|\n| c | d |")).toBe("A · B c · d");
  });

  it("leaves ordinary prose alone", () => {
    expect(toProse("Drift is when a price is not what this app last wrote.")).toBe(
      "Drift is when a price is not what this app last wrote.",
    );
  });
});
