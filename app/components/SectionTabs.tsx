import { useLocation, useSearchParams } from "react-router";

import { PageWidth } from "./PageShell";
import { TabBar } from "./TabBar";
import { PAGE_INSET } from "../lib/ui/spacing";

export interface SectionTab {
  href: string;
  label: string;
  /** Shown beside the label. Zero is not shown — an empty count is noise. */
  badge?: number;
}

/**
 * Sub-navigation for a section that gathers several former top-level routes.
 *
 * One component for prices, imports and settings. There were two — `SectionNav` and
 * `PricesTabs`, written a few tickets apart, differing in whether they carried the query
 * string. Two components doing one job, drifting in exactly the way this epic exists to
 * stop, is not a thing to leave in the codebase that is fixing it.
 *
 * The bar itself is `TabBar`, shared with the campaign page and the campaigns index for
 * the same reason. What is left here is the part that is genuinely about *sections*: the
 * query string, and what "current" means when tabs are separate routes.
 *
 * **The links carry the query string.** Searching for a SKU on one tab and switching to
 * another is a merchant asking about that SKU, not asking to start again. `page` is
 * dropped: page 4 of one tab is not page 4 of the next, and landing on an empty page
 * reads as "nothing here" rather than "wrong page".
 *
 * The current tab is matched exactly, never by prefix. A section root like `/app/prices`
 * prefixes every other tab in its section, so `startsWith` would light up the first tab
 * on every page.
 *
 * The one exception is a tab's own sub-pages. `/app/prices/baselines/recapture` is a page
 * *of* the Baselines tab — reached from it, and about the thing that tab lists — so the
 * bar has to say Baselines rather than nothing. Excluding the section root from the
 * prefix rule is what keeps that from becoming the bug above: every tab in a section is
 * under the root, so the root is the one href that must never prefix-match.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();

  const carried = new URLSearchParams(params);
  carried.delete("page");
  const query = carried.toString();

  return (
    // Inset to the same width as the pages below it. A section's tabs are rendered by the
    // layout route, above the `Outlet`, so they are not inside any `PageShell` — and left
    // alone they ran edge to edge while the page started a tenth of the way in.
    <PageWidth>
      {/* `s-page` insets its own contents by this much, so without it the tabs sit a
          few pixels left of the card they belong to — which after the inset is the only
          misalignment left on the page, and the kind that reads as sloppiness rather
          than as a choice. Matched by putting the two side by side and looking. */}
      <s-box paddingInline={PAGE_INSET}>
        <TabBar
          label="Sections"
          tabs={tabs.map((tab) => ({
            label: tab.label,
            badge: tab.badge,
            current: isCurrent(pathname, tab.href, tabs),
            href: query ? `${tab.href}?${query}` : tab.href,
          }))}
        />
      </s-box>
    </PageWidth>
  );
}

/**
 * Whether this tab is the one being looked at.
 *
 * Exact match, or a page beneath it — but never for the section root, which is a prefix
 * of every tab in the section and would otherwise be permanently current.
 *
 * The root is identified by being a prefix of another tab's href rather than by being
 * first in the list, so a section that reorders its tabs cannot quietly break this.
 */
export function isCurrent(pathname: string, href: string, tabs: { href: string }[]): boolean {
  if (pathname === href) return true;

  const isRoot = tabs.some((other) => other.href !== href && other.href.startsWith(`${href}/`));
  return !isRoot && pathname.startsWith(`${href}/`);
}
