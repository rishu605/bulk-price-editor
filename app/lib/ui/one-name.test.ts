/**
 * One place, one name.
 *
 * The prices section had three words for its first page, read in the order a merchant
 * meets them: the nav item said **Prices**, its first tab said **Variants**, and the page
 * that tab opened was headed **Catalogue**. Its fourth tab said "What's live" over a page
 * headed "What is live, and why", and its fifth said "Drift" over a page headed "Price
 * drift" that Home linked to as the "Drift queue".
 *
 * None of those is wrong on its own, which is exactly why it happened: each was written
 * where it reads best, by somebody looking at one of them. The cost lands on the merchant
 * who reads them in sequence and has to decide whether they are the same thing.
 *
 * Epic 14 already drew the rule for nav items — a nav item is a noun — and this is its
 * other half: a tab and the page it opens are the same noun. Checked against the routes
 * directory rather than a list, so a sixth tab is covered without anybody remembering
 * this file exists.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

/** `{ href: "…", label: "…" }` entries from a section layout's tab list. */
function tabs(source: string): Array<{ href: string; label: string }> {
  return [...source.matchAll(/\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((match) => ({
    href: match[1],
    label: match[2],
  }));
}

/** The `heading` a route hands `PageShell`, or null if that file is not the one. */
function heading(routeFile: string): string | null {
  try {
    const source = sourceOf(process.cwd(), "app", "routes", routeFile);
    return /<PageShell[\s\S]{0,600}?heading="([^"]+)"/.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which route file serves a path.
 *
 * Flat routes give a section's page two possible shapes, and which one it is depends on
 * whether the path has children of its own: `/app/prices/baselines` is
 * `app.prices.baselines._index.tsx` precisely because `/recapture` hangs off it, while
 * `/app/prices/costs` is `app.prices.costs.tsx`. Both are tried rather than guessed.
 */
function routeFilesFor(href: string): string[] {
  const flat = href.replace(/^\//, "").replace(/\//g, ".");
  return [`${flat}.tsx`, `${flat}._index.tsx`];
}

const SECTIONS = [
  { layout: "app.prices.tsx", index: "app.prices._index.tsx" },
  { layout: "app.settings.tsx", index: "app.settings._index.tsx" },
];

describe("a tab and the page it opens are the same noun", () => {
  for (const section of SECTIONS) {
    const list = tabs(sourceOf(process.cwd(), "app", "routes", section.layout));

    it(`${section.layout} has tabs to check`, () => {
      expect(list.length).toBeGreaterThanOrEqual(4);
    });

    for (const tab of list) {
      it(`${tab.label} → ${tab.href}`, () => {
        const candidates = tab.href.endsWith("/prices") || tab.href.endsWith("/settings")
          ? [section.index]
          : routeFilesFor(tab.href);

        const title = candidates.map(heading).find((found) => found !== null) ?? null;

        expect(title, `no route file found for ${tab.href}`).not.toBeNull();

        // The one deliberate exception, and it names itself: settings' first tab is a
        // page of three subjects — "Guardrails, rounding & alerts" — and the page under
        // it is "Settings". A label listing what a page holds is not a second name for
        // it, and #352 records why those three live together.
        if (tab.label.includes(",")) return;

        expect(
          title,
          `the tab says "${tab.label}" and the page it opens says "${title}"`,
        ).toBe(tab.label);
      });
    }
  }
});

describe("Home links to a page by the page's own name", () => {
  const home = sourceOf(process.cwd(), "app", "routes", "app._index.tsx");

  it("does not invent a fourth name for the drift page", () => {
    // It called it the "Drift queue" while the tab said "Drift" and the page said "Price
    // drift".
    const links = [...home.matchAll(/href="\/app\/prices\/drift">([^<]+)</g)].map((m) => m[1]);

    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const label of links) {
      // The page's own name has to appear in the label. A button inside a banner is a
      // sentence and a tab is a noun, so they need not match word for word — but
      // "Drift queue" is a name the merchant will not find anywhere they land.
      expect(
        label.toLowerCase(),
        `"${label}" is a name for this page that the page does not use`,
      ).toContain("price drift");
    }
  });
});
