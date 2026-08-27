import { Link, useLocation, useSearchParams } from "react-router";

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
    <s-stack direction="inline" gap="base">
      {tabs.map((tab) => {
        const current = pathname === tab.href;
        const label = tab.badge ? `${tab.label} (${tab.badge})` : tab.label;

        return current ? (
          <s-text key={tab.href} type="strong">
            {label}
          </s-text>
        ) : (
          <Link key={tab.href} to={query ? `${tab.href}?${query}` : tab.href}>
            {label}
          </Link>
        );
      })}
    </s-stack>
  );
}
