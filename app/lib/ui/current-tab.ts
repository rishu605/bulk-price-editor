/**
 * Whether a tab is current, and how the link says so (#797, #1016).
 */

/**
 * How current a tab is: it is the page being shown, the page shown is beneath it, or
 * neither. `true` is the page itself, for tabs that are only ever one page.
 */
export type Currentness = boolean | "page" | "beneath";

/**
 * Whether a section tab is the one being looked at, and how.
 *
 * Exact match, or a page beneath it -- but never the section root from beneath, which is a
 * prefix of every tab in the section and would otherwise be permanently current.
 *
 * The root is identified by being a prefix of another tab's href rather than by being
 * first in the list, so a section that reorders its tabs cannot quietly break this.
 */
export function currentness(pathname: string, href: string, tabs: { href: string }[]): "page" | "beneath" | false {
  if (pathname === href) return "page";

  const isRoot = tabs.some((other) => other.href !== href && other.href.startsWith(`${href}/`));
  return !isRoot && pathname.startsWith(`${href}/`) ? "beneath" : false;
}

/**
 * The link's `aria-current`.
 *
 * `"page"` says the link goes to the page being shown. Beneath a tab (Baselines →
 * recapture) it does not -- pressing it goes up a level -- so it is `"true"` there: the
 * current item in the set, which is what the indicator under it shows.
 */
export function ariaCurrent(current: Currentness | undefined): "page" | "true" | undefined {
  if (current === "beneath") return "true";
  return current ? "page" : undefined;
}
