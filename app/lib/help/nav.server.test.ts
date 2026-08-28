/**
 * The index is the help centre's navigation, and four surfaces are built from it.
 *
 * The landing page's sections, the sidebar on every page, each page's breadcrumb and its
 * next/previous links all come from `docs/help/index.md`. That is the point — one file a
 * writer already maintains rather than a second list in TypeScript that goes stale
 * silently. The risk it buys is that the parser and the prose can disagree, so these tests
 * are about the two staying in step.
 *
 * The one that matters most is the orphan check. A page absent from the index is a page no
 * merchant can reach by browsing: it exists, it is served, it answers a question, and
 * nothing anywhere links to it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { placeInNav, sectionTitleOf, startingPoints } from "./nav";
import { helpNav, parseNav } from "./nav.server";
import { INDEX_SLUG, readHelpPage, resolveHelpFile } from "./pages.server";

const HELP_ROOT = join(process.cwd(), "docs", "help");

/** Pages that exist but are not merchant-facing, and so are not expected in the index. */
const NOT_HELP = new Set([INDEX_SLUG, "images/README"]);

function publishedSlugs(): string[] {
  const slugs: string[] = [];

  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md")) slugs.push(prefix + entry.name.replace(/\.md$/, ""));
    }
  };

  walk(HELP_ROOT, "");
  return slugs.filter((slug) => !NOT_HELP.has(slug)).sort();
}

const listed = () => helpNav().sections.flatMap((section) => section.items.map((item) => item.slug));

describe("the index and the pages agree", () => {
  it("has no page nothing links to", () => {
    const reachable = new Set(listed());
    const orphans = publishedSlugs().filter((slug) => !reachable.has(slug));

    expect(orphans, "published but absent from docs/help/index.md").toEqual([]);
  });

  it("has no entry pointing at a page we do not publish", () => {
    for (const slug of listed()) {
      expect(resolveHelpFile(slug), `the index lists ${slug}, which is not a page`).not.toBeNull();
    }
  });

  it("loses nothing from the file it is built from", () => {
    // Every markdown link in the index has to survive parsing. Without this, a mistyped
    // list marker silently deletes a page from the navigation and nothing else notices.
    const source = readFileSync(join(HELP_ROOT, `${INDEX_SLUG}.md`), "utf8");
    const links = [...source.matchAll(/\]\((\.[^)]+)\)/g)].length;

    expect(listed()).toHaveLength(links);
  });

  it("gives every section something to introduce it with", () => {
    for (const section of helpNav().sections) {
      expect(section.blurb, `${section.title} has no description`).toBeTruthy();
      expect(section.items.length, `${section.title} is empty`).toBeGreaterThan(0);
    }
  });

  it("has a lede, which is the first thing on the landing page", () => {
    expect(helpNav().lede).toBeTruthy();
    expect(helpNav().title).toBe("Anchor help");
  });
});

describe("where a page sits", () => {
  it("names the section a breadcrumb shows", () => {
    expect(sectionTitleOf(helpNav(), "concepts/baselines")).toBe("Concepts");
    expect(sectionTitleOf(helpNav(), "failures/stuck-runs")).toBe("When something goes wrong");
    expect(sectionTitleOf(helpNav(), "images/README")).toBeNull();
  });

  it("walks a section in the order the index puts it in", () => {
    const place = placeInNav(helpNav(), "concepts/revert")!;

    expect(place.previous?.slug).toBe("concepts/resolver");
    expect(place.next?.slug).toBe("concepts/drift");
  });

  it("has no previous at the start of a section, and no next at the end", () => {
    expect(placeInNav(helpNav(), "concepts/baselines")!.previous).toBeNull();
    expect(placeInNav(helpNav(), "failures/unexpected")!.next).toBeNull();
  });

  /**
   * Guardrails are listed twice — as a concept, and as a thing that stops a run. The
   * sidebar marks one entry and the breadcrumb names one section, so the tie is broken by
   * order rather than left to whichever the loop reached last.
   */
  it("puts a page listed twice in the first section that claims it", () => {
    expect(sectionTitleOf(helpNav(), "failures/guardrail-blocks")).toBe("Concepts");
  });

  it("offers the first page of each section as a starting point", async () => {
    const starts = startingPoints(helpNav());

    expect(starts.map((item) => item.slug)).toEqual([
      "concepts/baselines",
      "how-to/first-campaign",
      "failures/partial-runs",
    ]);

    // These are rendered as a sentence — "start with what a baseline is" — so the label
    // has to read as a phrase rather than as a headline.
    for (const item of starts) {
      expect((await readHelpPage(item.slug))!.title).toBeTruthy();
    }
  });
});

describe("parsing prose that is not today's index", () => {
  it("reads a heading, its description and its entries", () => {
    const nav = parseNav(
      [
        "# A title",
        "",
        "A lede that runs",
        "over two lines.",
        "",
        "## First",
        "",
        "What this section is for.",
        "",
        "- [One](./a/one.md) — the first one",
        "- [Two](./a/two.md)",
      ].join("\n"),
    );

    expect(nav.title).toBe("A title");
    // A wrapped paragraph is one sentence, not two fragments.
    expect(nav.lede).toBe("A lede that runs over two lines.");
    expect(nav.sections).toHaveLength(1);
    expect(nav.sections[0]).toMatchObject({ id: "first", title: "First", blurb: "What this section is for." });
    expect(nav.sections[0].items).toEqual([
      { slug: "a/one", title: "One", blurb: "the first one" },
      { slug: "a/two", title: "Two", blurb: null },
    ]);
  });

  it("leaves out an entry that points somewhere we do not serve", () => {
    // A sidebar entry that navigates off the help centre is not navigation, and one
    // pointing at a page that does not exist is worse than none at all.
    const nav = parseNav(
      [
        "## Elsewhere",
        "",
        "- [Shopify](https://shopify.dev/docs)",
        "- [The RFC](../../rfc-001-architecture.md)",
        "- [A real page](./concepts/baselines.md)",
      ].join("\n"),
    );

    expect(nav.sections[0].items.map((item) => item.slug)).toEqual(["concepts/baselines"]);
  });

  it("does not mistake prose after the first entry for the description", () => {
    const nav = parseNav(["## S", "", "The description.", "", "- [A](./a.md)", "", "A footnote."].join("\n"));

    expect(nav.sections[0].blurb).toBe("The description.");
  });
});
