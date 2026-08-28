/**
 * Every section's landing page is reachable from its own tab bar.
 *
 * `SectionTabs` matches the current path **exactly**, never by prefix — deliberately, and
 * for a good reason: a section root like `/app/prices` is a prefix of every tab under it,
 * so `startsWith` lights up the first tab on every page in the section.
 *
 * The consequence nobody checked is that an index route which is not *in* the list can
 * never be current. `/app/imports` — the list of files a merchant has imported, and where
 * the nav item points — rendered a bar of four links with nothing selected, and once you
 * left it there was no way back. Prices and Settings both listed theirs; Imports did not,
 * and nothing said which was the mistake.
 *
 * Derived from the routes directory rather than a second hand-kept list, the way
 * `legacy-routes.test.ts` is: a list of sections maintained here would go stale in exactly
 * the way this is checking for.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROUTES = join(process.cwd(), "app", "routes");

/**
 * Every layout route that renders a `SectionTabs`, with the hrefs it lists.
 *
 * A layout route is `app.<section>.tsx` with an `app.<section>._index.tsx` beside it —
 * which is what having a landing page means in flat-routes.
 */
function sections() {
  const files = readdirSync(ROUTES);

  return files
    .filter((file) => /^app\.[a-z-]+\.tsx$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(ROUTES, file), "utf8") }))
    .filter(({ source }) => source.includes("<SectionTabs"))
    .map(({ file, source }) => ({
      file,
      section: file.replace(/^app\./, "").replace(/\.tsx$/, ""),
      hasIndex: files.includes(file.replace(/\.tsx$/, "._index.tsx")),
      hrefs: [...source.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]),
    }));
}

const SECTIONS = sections();

describe("a section's tab bar lists the section's own index", () => {
  it("finds the tabbed sections", () => {
    // Prices and settings. Imports was a third until it was dissolved: it was a nav item
    // named after a verb, and two of its five tabs — Baselines and Costs — were nouns
    // that already had a tab of their own under Prices.
    expect(SECTIONS.map((s) => s.section).sort()).toEqual(["prices", "settings"]);
  });

  it("every one of them has a landing page", () => {
    expect(SECTIONS.filter((s) => !s.hasIndex).map((s) => s.file)).toEqual([]);
  });

  it("lists that landing page as a tab, so it can be current and can be returned to", () => {
    const missing = SECTIONS.filter((s) => !s.hrefs.includes(`/app/${s.section}`)).map(
      (s) => `${s.file}: no tab for /app/${s.section}`,
    );

    expect(
      missing,
      "SectionTabs matches exactly, so an index that is not listed renders a bar with nothing selected",
    ).toEqual([]);
  });

  it("puts it first, because it is what the nav item points at", () => {
    const wrong = SECTIONS.filter((s) => s.hrefs[0] !== `/app/${s.section}`).map((s) => s.file);

    expect(wrong).toEqual([]);
  });

  it("names every tab a route that exists", () => {
    const files = readdirSync(ROUTES);
    const routeFor = (href: string) => {
      const flat = `${href.replace(/^\//, "").replace(/\//g, ".")}`;
      return files.includes(`${flat}.tsx`) || files.includes(`${flat}._index.tsx`);
    };

    const dangling = SECTIONS.flatMap((s) =>
      s.hrefs.filter((href) => !routeFor(href)).map((href) => `${s.file}: ${href}`),
    );

    expect(dangling).toEqual([]);
  });
});
