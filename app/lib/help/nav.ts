/**
 * The shape of the help centre, and the questions a page asks of it.
 *
 * Split from `nav.server.ts` deliberately. Reading `docs/help/index.md` off disk is a
 * server-only act, but "which section is this page in" and "what comes next" are asked by
 * the sidebar, the breadcrumb and the pager — components that render in the browser. Kept
 * in one module, the whole navigation dragged `node:fs` into the client bundle and the
 * build refused it, which is the correct refusal.
 */

export interface HelpNavItem {
  slug: string;
  title: string;
  /** The half-sentence after the em dash, or null where the title says enough. */
  blurb: string | null;
}

export interface HelpNavSection {
  /** Slugified heading, so a section can be linked to from a breadcrumb. */
  id: string;
  title: string;
  blurb: string | null;
  items: HelpNavItem[];
}

export interface HelpNav {
  /** The index's `#` heading. */
  title: string;
  /** The paragraph under it, before the first section. */
  lede: string | null;
  sections: HelpNavSection[];
}

/** Where a page sits, which is what a breadcrumb and a next/previous link are made of. */
export interface HelpPlace {
  section: HelpNavSection;
  previous: HelpNavItem | null;
  next: HelpNavItem | null;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Where a page sits in the index, or null if it is not listed.
 *
 * The first section wins. One page is deliberately listed twice — guardrails are both a
 * concept and a thing that stops a run — and a breadcrumb has to pick one.
 */
export function placeInNav(nav: HelpNav, slug: string): HelpPlace | null {
  for (const section of nav.sections) {
    const at = section.items.findIndex((item) => item.slug === slug);
    if (at === -1) continue;

    return {
      section,
      previous: section.items[at - 1] ?? null,
      next: section.items[at + 1] ?? null,
    };
  }

  return null;
}

/** The section a page belongs to, for labelling it in a list of search results. */
export function sectionTitleOf(nav: HelpNav, slug: string): string | null {
  return placeInNav(nav, slug)?.section.title ?? null;
}

/**
 * The first page of each section — what somebody who has just arrived should read.
 *
 * Derived rather than chosen, because a hand-picked list of "popular" pages is a second
 * thing to maintain and it is wrong the first time the index is reordered.
 */
export function startingPoints(nav: HelpNav): HelpNavItem[] {
  return nav.sections
    .map((section) => section.items[0])
    .filter((item): item is HelpNavItem => !!item);
}

/** How many accents the stylesheet defines, cycled across the index's sections. */
export const TONES = 3;

/** A section's accent, by its position in the index rather than by its name. */
export function toneOf(nav: HelpNav, section: HelpNavSection): number {
  return Math.max(0, nav.sections.indexOf(section)) % TONES;
}
