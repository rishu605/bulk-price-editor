/**
 * The help centre is public and takes its path from the URL, which makes two things worth
 * proving: that it cannot be talked into serving a file outside `docs/help`, and that a
 * merchant who follows a link inside a page arrives at a page that exists.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  escapesRoot,
  headingId,
  INDEX_SLUG,
  readHelpImage,
  readHelpPage,
  resolveHelpFile,
  rewriteHelpHref,
} from "./pages.server";

const HELP_ROOT = join(process.cwd(), "docs", "help");

/** Every page we publish, found the same way a reader would find them: by walking. */
function allSlugs(): string[] {
  const slugs: string[] = [];

  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md")) slugs.push(prefix + entry.name.replace(/\.md$/, ""));
    }
  };

  walk(HELP_ROOT, "");
  return slugs.sort();
}

describe("a URL cannot reach outside the help directory", () => {
  const escapes = [
    "../../package",
    "../../../etc/passwd",
    "concepts/../../../package",
    "concepts/../../.env",
    "..%2f..%2fpackage",
    "concepts/baselines%00",
    "concepts//../../package",
    ".",
    "..",
    "",
  ];

  it.each(escapes)("refuses %j", (slug) => {
    expect(resolveHelpFile(slug)).toBeNull();
  });

  it("refuses them at the reading layer too, not only the resolving one", async () => {
    for (const slug of escapes) {
      expect(await readHelpPage(slug), `${slug} was served`).toBeNull();
    }
  });

  // These stay inside `docs/help` and are refused for the ordinary reason — no such page.
  // Kept separate so the test above keeps meaning "this escaped" rather than "this 404s".
  it.each(["/absolute/path", "concepts/not-a-page", "how-to"])(
    "does not serve %j, which is inside the directory but is not a page",
    async (slug) => {
      expect(await readHelpPage(slug)).toBeNull();
    },
  );

  /**
   * The alphabet check is what stops traversal, and the containment check underneath it is
   * a backstop nothing can currently reach. These two tests pin the pair: the first proves
   * the backstop works if it is ever reached, the second proves that no string which gets
   * past the alphabet check needs it.
   */
  it("has a backstop that recognises a path outside the help directory", () => {
    expect(escapesRoot(join(HELP_ROOT, "concepts", "revert.md"))).toBe(false);
    expect(escapesRoot(join(HELP_ROOT, "..", "..", "package.json"))).toBe(true);
    expect(escapesRoot("/etc/passwd")).toBe(true);
    // A sibling directory whose name merely starts the same way.
    expect(escapesRoot(`${HELP_ROOT}-private/leak.md`)).toBe(true);
  });

  it("admits nothing that would need the backstop", () => {
    const characters = [..."abz09-/.%\\", "\u0000"];
    const admitted: string[] = [];

    // Every string up to three characters over an alphabet that includes everything a
    // traversal needs. Exhaustive rather than random, so it does not depend on a seed.
    const build = (prefix: string) => {
      if (prefix.length > 0 && resolveHelpFile(prefix) !== null) admitted.push(prefix);
      if (prefix.length === 3) return;
      for (const c of characters) build(prefix + c);
    };
    build("");

    expect(admitted.length, "the alphabet admitted nothing, so this proves nothing")
      .toBeGreaterThan(0);
    for (const slug of admitted) {
      expect(escapesRoot(resolveHelpFile(slug)!), `${slug} needed the backstop`).toBe(false);
    }
  });

  it("still serves the pages it should", () => {
    for (const slug of allSlugs()) {
      expect(resolveHelpFile(slug), `${slug} is published but unreachable`).not.toBeNull();
    }
  });
});

describe("every page renders", () => {
  it.each(allSlugs())("%s", async (slug) => {
    const page = await readHelpPage(slug);

    expect(page).not.toBeNull();
    // A page whose title fell back to the slug has no `#` heading, which means the browser
    // tab and the on-page heading disagree.
    expect(page!.title, `${slug} has no heading`).not.toBe(slug);
    expect(page!.html).toContain(`<h1 id="${headingId(page!.title)}">`);
  });
});

/**
 * The route renders a contents rail beside the prose and a card row under it, and both are
 * built from what this function returns rather than from a second pass over the HTML.
 * These assert the parts the reader can see are actually there.
 */
describe("a page arrives in the pieces the route lays out", () => {
  it("lists its own headings, each pointing at an anchor the page has", async () => {
    const page = (await readHelpPage("concepts/baselines"))!;

    expect(page.headings.map((h) => h.text)).toEqual([
      "Why it matters",
      "Where baselines come from",
      "When to recapture",
    ]);

    for (const heading of page.headings) {
      expect(page.html, `no anchor for ${heading.text}`).toContain(`id="${heading.id}"`);
    }
  });

  it("lifts the Related list out of the prose, with its links already resolved", async () => {
    const page = (await readHelpPage("concepts/baselines"))!;

    expect(page.related).toEqual([
      { href: "/help/concepts/revert", label: "Why revert recomputes" },
      { href: "/help/how-to/import-baselines", label: "Importing your own prices" },
    ]);

    // Lifted, not copied: leaving it in as well would render the same two links twice,
    // once as cards and once as the bullets the cards were built to replace.
    expect(page.html).not.toContain("Related");
    expect(page.headings.some((h) => h.text === "Related")).toBe(false);
  });

  it("leaves a page without a Related section whole", async () => {
    const page = (await readHelpPage("how-to/first-campaign"))!;

    expect(page.related).toEqual([]);
    expect(page.html).toContain("Reverting");
  });

  it("every Related link names a page we publish", async () => {
    for (const slug of allSlugs()) {
      for (const link of (await readHelpPage(slug))!.related) {
        const target = link.href.replace("/help/", "");
        expect(resolveHelpFile(target), `${slug} points at ${link.href}`).not.toBeNull();
      }
    }
  });

  it("finds Related sections to check — otherwise the assertion above proves nothing", async () => {
    const counts = await Promise.all(allSlugs().map(async (s) => (await readHelpPage(s))!.related.length));

    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
  });

  /**
   * A table is wider than the column the prose is set in. Without its own scroll box the
   * whole document scrolls sideways, which is the one thing a reader should never have to
   * do to finish a sentence.
   */
  it("gives a table somewhere to scroll that is not the page", async () => {
    const page = (await readHelpPage("how-to/shopify-flow"))!;

    expect(page.html).toContain('<div class="scroller"><table>');
  });
});

describe("links inside a page lead somewhere", () => {
  it.each(allSlugs())("%s", async (slug) => {
    const html = (await readHelpPage(slug))!.html;

    const targets = [...html.matchAll(/href="\/help\/([^"#?]+)/g)].map((m) => m[1]);

    for (const target of targets) {
      expect(resolveHelpFile(target), `${slug} links to /help/${target}, which we do not publish`)
        .not.toBeNull();
    }
  });

  it("finds links to check — otherwise the assertion above proves nothing", async () => {
    const index = (await readHelpPage(INDEX_SLUG))!.html;

    expect([...index.matchAll(/href="\/help\//g)].length).toBeGreaterThan(10);
  });

  it("leaves links we do not serve exactly as written", () => {
    expect(rewriteHelpHref("https://shopify.dev/docs", "index")).toBe("https://shopify.dev/docs");
    expect(rewriteHelpHref("mailto:support@example.com", "index")).toBe(
      "mailto:support@example.com",
    );
    expect(rewriteHelpHref("#a-heading-on-this-page", "concepts/revert")).toBe(
      "#a-heading-on-this-page",
    );
    // Climbing out of the help centre names something we do not publish. Visibly broken
    // beats silently pointing at the wrong page.
    expect(rewriteHelpHref("../../rfc-001-architecture.md", "concepts/revert")).toBe(
      "../../rfc-001-architecture.md",
    );
  });

  it("resolves a cross-link against the page it appears on, not the root", () => {
    expect(rewriteHelpHref("./revert.md", "concepts/baselines")).toBe("/help/concepts/revert");
    expect(rewriteHelpHref("../how-to/import-baselines.md", "concepts/baselines")).toBe(
      "/help/how-to/import-baselines",
    );
    expect(rewriteHelpHref("./concepts/baselines.md", INDEX_SLUG)).toBe("/help/concepts/baselines");
    expect(rewriteHelpHref("./revert.md#partial", "concepts/baselines")).toBe(
      "/help/concepts/revert#partial",
    );
  });
});

/**
 * Images are served from the same directory by the same rules.
 *
 * This route hands raw bytes to an unauthenticated caller from a path they supplied,
 * which is the shape of request that turns a help centre into a file server.
 */
describe("serving an image belonging to a page", () => {
  it("serves one that exists, with the right type", async () => {
    const image = await readHelpImage("images/resolver.svg");

    expect(image).not.toBeNull();
    expect(image!.contentType).toBe("image/svg+xml");
    expect(image!.body.length).toBeGreaterThan(100);
  });

  it.each([
    "images/../../package.json",
    "../../package.json",
    "../../../etc/passwd",
    "images/..%2f..%2fpackage.json",
    // The ones that matter: a traversal wearing an extension we do serve, so the type
    // allowlist waves them through and something else has to stop them.
    "../../app/root.png",
    "images/../../../etc/hosts.png",
    "images/../../app/db.server.svg",
  ])("refuses %j", async (path) => {
    expect(await readHelpImage(path)).toBeNull();
  });

  it("refuses a type we do not publish, whatever the file is", async () => {
    // The allowlist is on the extension, so a markdown page cannot be served as bytes
    // and an executable cannot be served at all.
    expect(await readHelpImage("concepts/resolver.md")).toBeNull();
    expect(await readHelpImage("images/resolver.exe")).toBeNull();
    expect(await readHelpImage("images/resolver")).toBeNull();
  });

  it("refuses an image that is not there", async () => {
    expect(await readHelpImage("images/not-a-picture.png")).toBeNull();
  });
});

describe("pictures in a page point at the route that serves them", () => {
  it("rewrites a relative image path to an absolute one", () => {
    expect(rewriteHelpHref("../images/resolver.svg", "concepts/resolver")).toBe(
      "/help/images/resolver.svg",
    );
    // Unlike a page, an asset keeps its extension — that is how its type is decided.
    expect(rewriteHelpHref("./diagram.png", "how-to/first-campaign")).toBe(
      "/help/how-to/diagram.png",
    );
  });

  it("every image a page renders is one the help centre will serve", async () => {
    let checked = 0;

    for (const slug of allSlugs()) {
      const html = (await readHelpPage(slug))!.html;

      for (const match of html.matchAll(/<img[^>]+src="\/help\/([^"]+)"/g)) {
        expect(await readHelpImage(match[1]), `${slug} shows ${match[1]}`).not.toBeNull();
        checked += 1;
      }
    }

    expect(checked, "no page shows an image, so this proves nothing").toBeGreaterThan(0);
  });

  it("gives every image on every page alt text that says what it shows", async () => {
    // A picture explaining a concept is useless to a screen reader if its alt text is
    // "diagram" or "screenshot", and a screenshot with none at all is worse than absent.
    let checked = 0;

    for (const slug of allSlugs()) {
      const html = (await readHelpPage(slug))!.html;

      for (const match of html.matchAll(/<img[^>]*alt="([^"]*)"/g)) {
        const alt = match[1]!;
        expect(alt.length, `${slug} has an image with alt text of ${alt.length} characters`)
          .toBeGreaterThan(40);
        expect(["diagram", "screenshot", "image"]).not.toContain(alt.toLowerCase());
        checked += 1;
      }
    }

    expect(checked, "no page has an image, so this proves nothing").toBeGreaterThan(2);
  });

  it("gives the resolver diagram alt text that says what it shows", async () => {
    // A diagram explaining the one concept merchants misunderstand is useless to a
    // screen reader if its alt text is "diagram".
    const html = (await readHelpPage("concepts/resolver"))!.html;
    const alt = /<img[^>]*alt="([^"]*)"/.exec(html)?.[1] ?? "";

    expect(alt.length).toBeGreaterThan(40);
    expect(alt.toLowerCase()).not.toBe("diagram");
  });
});
