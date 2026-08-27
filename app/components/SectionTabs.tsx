import { useLocation, useSearchParams } from "react-router";

import { TabBar } from "./TabBar";

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
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();

  const carried = new URLSearchParams(params);
  carried.delete("page");
  const query = carried.toString();

  return (
    <TabBar
      label="Sections"
      tabs={tabs.map((tab) => ({
        label: tab.label,
        badge: tab.badge,
        current: pathname === tab.href,
        href: query ? `${tab.href}?${query}` : tab.href,
      }))}
    />
  );
}
