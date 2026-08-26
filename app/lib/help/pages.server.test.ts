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
    expect(page!.html).toContain("<h1>");
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

  it("gives every image alt text that says what it shows", async () => {
    // A diagram explaining the one concept merchants misunderstand is useless to a
    // screen reader if its alt text is "diagram".
    const html = (await readHelpPage("concepts/resolver"))!.html;
    const alt = /<img[^>]*alt="([^"]*)"/.exec(html)?.[1] ?? "";

    expect(alt.length).toBeGreaterThan(40);
    expect(alt.toLowerCase()).not.toBe("diagram");
  });
});
