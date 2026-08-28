/**
 * The help centre's navigation, read from the index page.
 *
 * `docs/help/index.md` is a curated list — somebody decided the order, the grouping and
 * the half-sentence that says why each page is worth opening. Rendering it as markdown
 * threw all of that away and produced a wall of underlined blue text, which is the
 * opposite of what a curated list is for.
 *
 * So the index is parsed rather than rendered. The same file that reads correctly on
 * GitHub becomes the landing page's sections, every page's sidebar, its breadcrumb, and
 * its next/previous links. One source, four surfaces, and no second list to forget to
 * update — the failure mode of every hand-maintained navigation ever written.
 *
 * A page missing from the index is therefore unreachable by browsing. That is asserted
 * rather than hoped for; see the orphan test in `nav.server.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HELP_ROUTE } from "../errors/help-links";

import { slugify, type HelpNav } from "./nav";
import { INDEX_SLUG, rewriteHelpHref } from "./pages.server";

const INDEX_FILE = join(process.cwd(), "docs", "help", `${INDEX_SLUG}.md`);

/** `- [Title](./somewhere.md) — why it is worth opening` */
const ITEM = /^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.+))?$/;

let cached: HelpNav | null = null;

/**
 * Read once and keep, exactly as the search index does: the file ships inside the
 * container image and cannot change under a running process.
 */
export function helpNav(): HelpNav {
  return (cached ??= parseNav(readFileSync(INDEX_FILE, "utf8")));
}

/**
 * Exported so the parser can be tested against prose that is not today's index — a
 * guarantee that only holds for the current file is not a guarantee.
 */
export function parseNav(markdown: string): HelpNav {
  const nav: HelpNav = { title: "Help", lede: null, sections: [] };

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    if (heading) {
      const title = heading[2].trim();
      if (heading[1] === "#") nav.title = title;
      else nav.sections.push({ id: slugify(title), title, blurb: null, items: [] });
      continue;
    }

    const section = nav.sections.at(-1);

    const item = ITEM.exec(line);
    if (item) {
      const slug = slugFromHref(item[2]);
      // A list entry pointing somewhere we do not publish is a link, not a page, and has
      // no place in a sidebar. Leaving it out is what makes every nav entry navigable.
      if (section && slug) {
        section.items.push({ title: item[1].trim(), slug, blurb: item[3]?.trim() || null });
      }
      continue;
    }

    // Prose. Before the first heading it is the lede; under one it introduces the section.
    // Wrapped paragraphs join back into a sentence rather than arriving as fragments.
    if (!section) nav.lede = appendLine(nav.lede, line);
    else if (section.items.length === 0) section.blurb = appendLine(section.blurb, line);
  }

  return nav;
}

function appendLine(existing: string | null, line: string): string {
  return existing ? `${existing} ${line}` : line;
}

/** The route a relative markdown link resolves to, as a slug — or null if we do not serve it. */
function slugFromHref(href: string): string | null {
  const resolved = rewriteHelpHref(href, INDEX_SLUG);
  const prefix = `${HELP_ROUTE}/`;

  return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : null;
}
