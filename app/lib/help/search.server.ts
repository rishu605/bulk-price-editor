/**
 * Search across the help centre.
 *
 * Twenty pages is small enough that scanning all of them per query costs less than a
 * millisecond, so there is no index to build, invalidate or get wrong. If the help centre
 * ever grows past a few hundred pages this should be reconsidered — but building a search
 * index for twenty documents would be answering a question nobody asked.
 *
 * The ranking is deliberately crude and explained rather than tuned: a merchant searching
 * "drift" wants the page called drift, not the six pages that mention it in passing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "docs", "help");

/**
 * Pages that are in `docs/help` but are not help.
 *
 * The index is the thing you search *from*; returning it as a result is noise. The note in
 * `images/` is for whoever next takes a screenshot — it explains the crop that keeps a
 * competitor's name out of the picture — and a merchant searching "price" should not be
 * handed our editorial standards as an answer.
 */
const EXCLUDED = new Set(["index", "images/README"]);

export interface HelpHit {
  slug: string;
  title: string;
  /** The text around the match, for showing why this page matched. */
  snippet: string;
  /** Character offsets of the match within `snippet`, so the caller can mark it. */
  match: { start: number; end: number } | null;
}

interface Document {
  slug: string;
  title: string;
  /** Markdown stripped down to prose, so a match cannot land inside syntax. */
  text: string;
  headings: string;
}

let cached: Document[] | null = null;

/**
 * Read once and keep. The files ship inside the container image and cannot change under a
 * running process, so re-reading them per query would buy nothing.
 */
function documents(): Document[] {
  if (cached) return cached;

  const docs: Document[] = [];

  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;

      const slug = prefix + entry.name.replace(/\.md$/, "");
      if (EXCLUDED.has(slug)) continue;

      const source = readFileSync(join(dir, entry.name), "utf8");
      docs.push({
        slug,
        title: /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? slug,
        // The `#` heading is shown as the result's title, so leaving it in the prose makes
        // every snippet open by repeating the line directly above it.
        text: toProse(source.replace(/^#\s+.+$/m, "")),
        headings: [...source.matchAll(/^#{2,}\s+(.+)$/gm)].map((m) => m[1]).join(" · "),
      });
    }
  };

  walk(ROOT, "");
  cached = docs.sort((a, b) => a.slug.localeCompare(b.slug));
  return cached;
}

/**
 * Markdown to something a merchant would recognise as the sentence they read.
 *
 * Without this, a search for "price" matches the `](./prices.md)` inside a link and the
 * snippet shows the merchant a fragment of markup, which reads as a bug.
 *
 * Exported for its test: whether a snippet happens to land on a link depends on the docs,
 * and a guarantee that only holds for today's prose is not a guarantee.
 */
export function toProse(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map(tableRowToProse)
    .join("\n")
    .replace(/^#{1,6}\s+/gm, "")
    // Images before links, because an image is a link with a `!` in front. Dropped whole
    // rather than reduced to their alt text: several pages open with a screenshot, and its
    // alt text is a description of a picture — as the first line of a search result it
    // reads as the page being about the screenshot rather than about the subject.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A table row as a sentence-ish fragment rather than its cells run together.
 *
 * Stripping the pipes alone turned "| Campaign held for drift | A campaign stopped… |"
 * into one unpunctuated run, which in a search result reads as corrupted text. The
 * separator row (`|---|---|`) carries no words at all and is dropped.
 */
function tableRowToProse(line: string): string {
  if (!/^\s*\|/.test(line)) return line;
  if (/^[\s|:-]+$/.test(line)) return "";

  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(" · ");
}

/**
 * Rank a page against a query.
 *
 * Title beats heading beats body, because a page *about* the thing is almost always what
 * was wanted. Every term must appear somewhere, so a two-word query narrows rather than
 * widens — the opposite behaviour makes a search box feel broken.
 */
function score(doc: Document, terms: string[]): number {
  const title = doc.title.toLowerCase();
  const headings = doc.headings.toLowerCase();
  const text = doc.text.toLowerCase();

  let total = 0;

  for (const term of terms) {
    const inTitle = title.includes(term);
    const inHeadings = headings.includes(term);
    const inText = text.includes(term);

    if (!inTitle && !inHeadings && !inText) return 0;

    if (inTitle) total += title === term ? 100 : 30;
    if (inHeadings) total += 8;
    if (inText) total += 1;
  }

  return total;
}

const SNIPPET_RADIUS = 90;

/** The prose around the first term that appears, with the offsets of that term. */
function snippetFor(doc: Document, terms: string[]): Pick<HelpHit, "snippet" | "match"> {
  const lower = doc.text.toLowerCase();

  let at = -1;
  let term = "";
  for (const candidate of terms) {
    const found = lower.indexOf(candidate);
    if (found !== -1 && (at === -1 || found < at)) {
      at = found;
      term = candidate;
    }
  }

  // Matched on the title alone: the opening sentence says more than nothing.
  if (at === -1) {
    return { snippet: clamp(doc.text.slice(0, SNIPPET_RADIUS * 2), false, true), match: null };
  }

  const from = wordBoundaryBefore(doc.text, Math.max(0, at - SNIPPET_RADIUS));
  const to = wordBoundaryAfter(doc.text, Math.min(doc.text.length, at + term.length + SNIPPET_RADIUS));
  const body = clamp(doc.text.slice(from, to), from > 0, to < doc.text.length);
  const offset = at - from + (from > 0 ? 1 : 0);

  return { snippet: body, match: { start: offset, end: offset + term.length } };
}

/**
 * Snippets are cut to a character count, which lands mid-word about as often as not.
 * "…ign's prices are reverted" is a distraction in a list a merchant is scanning.
 */
function wordBoundaryBefore(text: string, at: number): number {
  if (at === 0) return 0;
  const space = text.indexOf(" ", at);
  return space === -1 ? at : space + 1;
}

function wordBoundaryAfter(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const space = text.lastIndexOf(" ", at);
  return space <= 0 ? at : space;
}

function clamp(text: string, before: boolean, after: boolean): string {
  return `${before ? "…" : ""}${text}${after ? "…" : ""}`;
}

/**
 * Pages matching a query, best first. An empty or whitespace query returns nothing rather
 * than everything, because "everything" is what the index page is already for.
 */
export function searchHelp(query: string, limit = 8): HelpHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  return documents()
    .map((doc) => ({ doc, rank: score(doc, terms) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank || a.doc.slug.localeCompare(b.doc.slug))
    .slice(0, limit)
    .map(({ doc }) => ({ slug: doc.slug, title: doc.title, ...snippetFor(doc, terms) }));
}
