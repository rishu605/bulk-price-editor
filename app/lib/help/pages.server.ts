/**
 * Reading a help page off disk, safely.
 *
 * The help centre is twenty-one markdown files in `docs/help`, committed alongside the
 * code that links to them — which is what keeps the two from drifting. Serving them is
 * what makes those links resolve at all: `HELP_BASE` defaulted to a domain nobody had
 * registered, so every merchant-visible error carried a link to nothing.
 *
 * **One thing this is not.** Serving help from the app means the page explaining "the app
 * is unavailable" is unavailable exactly when a merchant needs it. That is a real
 * limitation and the reason `HELP_BASE_URL` exists: point it at independent hosting before
 * launch and the failure docs survive an outage of the thing they describe. Until then, a
 * page that is usually reachable beats a link that never was.
 */

import { readFile } from "node:fs/promises";
import { join, normalize, posix, sep } from "node:path";

import { marked, type Tokens } from "marked";

/** Where the markdown lives, relative to the process's working directory. */
const ROOT = join(process.cwd(), "docs", "help");

/** The page served when no slug is given — the curated index, not a generated list. */
export const INDEX_SLUG = "index";

export interface HelpPage {
  /** The `#` heading, used as the document title. */
  title: string;
  html: string;
}

/**
 * Turns a URL path into a file path, or null if it does not name a page we publish.
 *
 * This is the security boundary for the route, which is deliberately unauthenticated: a
 * merchant may arrive from an error message outside the admin, or from an email. `..` in a
 * URL is the oldest way to read a file the author never meant to serve.
 *
 * The alphabet check is what does the work. It admits only the characters a real slug
 * uses, and because `.` is not among them there is no traversal to normalise away — the
 * encoded and doubled-up forms that defeat a naive `includes("..")` never get past it
 * either, since `%` is not allowed and neither is a leading dot.
 *
 * The containment check below it is therefore unreachable today, and mutation testing says
 * so: deleting it fails no test. It stays as a backstop, and its value is conditional — if
 * somebody ever widens the alphabet (a page with a dot in its name, say), that change
 * turns into a 404 rather than a file disclosure. `escapesRoot` exists so the property
 * that makes this safe is asserted rather than assumed.
 */
export function resolveHelpFile(slug: string): string | null {
  const cleaned = slug.replace(/^\/+|\/+$/g, "");
  if (!cleaned) return null;

  if (!SLUG_ALPHABET.test(cleaned)) return null;

  const candidate = normalize(join(ROOT, `${cleaned}.md`));

  return escapesRoot(candidate) ? null : candidate;
}

/** The only shape a published page's path may have. */
const SLUG_ALPHABET = /^[a-z0-9][a-z0-9/-]*$/i;

/** Exported so the backstop can be tested directly, since nothing else can reach it. */
export function escapesRoot(candidate: string): boolean {
  return !candidate.startsWith(ROOT + sep);
}

/**
 * Rewrites a markdown cross-link into a route this app serves.
 *
 * The docs link each other the way files do — `./revert.md`, `../concepts/revert.md` —
 * because they are also read in the repo and on GitHub, where that is the form that works.
 * Served over HTTP those 404, so they are resolved against the current page's directory
 * and stripped of the extension. Anything absolute is left exactly as written.
 *
 * Exported because the test for it is the only thing standing between a merchant and a
 * help page whose every onward link is dead.
 */
export function rewriteHelpHref(href: string, fromSlug: string): string {
  if (!href.startsWith(".") && !/^[a-z0-9][a-z0-9-]*\.md([#?].*)?$/i.test(href)) {
    return href;
  }

  const [path, fragment = ""] = splitFragment(href);
  if (!path.endsWith(".md")) return href;

  const dir = posix.dirname(fromSlug);
  const resolved = posix
    .normalize(posix.join(dir === "." ? "" : dir, path))
    .replace(/\.md$/, "");

  // A link that climbs out of `docs/help` names something we do not publish. Leaving it
  // untouched makes it visibly broken rather than silently pointing at a wrong page.
  if (resolved.startsWith("..")) return href;

  return `/help/${resolved}${fragment}`;
}

function splitFragment(href: string): [string, string] {
  const at = href.search(/[#?]/);
  return at === -1 ? [href, ""] : [href.slice(0, at), href.slice(at)];
}

export async function readHelpPage(slug: string): Promise<HelpPage | null> {
  const file = resolveHelpFile(slug);
  if (!file) return null;

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return null;
  }

  // The `#` heading is the title. Falling back to the slug rather than to a generic word,
  // because a browser tab reading "Help" for every page is a tab nobody can find again.
  const heading = /^#\s+(.+)$/m.exec(source)?.[1]?.trim();

  const html = marked.parse(source, {
    // `async: false` keeps the return type a string rather than a union. The markdown is
    // ours and committed, so there is nothing untrusted to sanitise — but that is a
    // property of where it comes from, not of this function, and it stops being true the
    // moment anything here is written by a merchant.
    async: false,
    // Mutating the token rather than overriding the renderer: link text, titles and
    // nested emphasis keep rendering the way marked already renders them.
    walkTokens: (token) => {
      if (token.type === "link") {
        const link = token as Tokens.Link;
        link.href = rewriteHelpHref(link.href, slug);
      }
    },
  });

  return { title: heading ?? slug, html };
}
