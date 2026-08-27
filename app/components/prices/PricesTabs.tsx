import { Link, useLocation, useSearchParams } from "react-router";

export interface PricesTab {
  href: string;
  label: string;
  /** Shown beside the label. Zero is not shown — an empty count is noise. */
  badge?: number;
}

/**
 * The prices section's tabs.
 *
 * Five views of the same variant rows: what the storefront shows, what it should show,
 * what it costs, what we last wrote, and where the two disagree. They were five
 * top-level nav items, which made them read as five features rather than five columns.
 *
 * **The tab links carry the query string.** Searching for a SKU in Baselines and
 * switching to What's live is a merchant asking about that SKU, not asking to start
 * again. Dropping the query on a tab switch is the small betrayal that teaches people
 * to distrust a filter.
 *
 * `page` is deliberately dropped: page 4 of the baselines is not page 4 of drift, and
 * landing on an empty page reads as "nothing here" rather than "wrong page".
 */
export function PricesTabs({ tabs }: { tabs: PricesTab[] }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();

  const carried = new URLSearchParams(params);
  carried.delete("page");
  const query = carried.toString();

  return (
    <s-stack direction="inline" gap="base">
      {tabs.map((tab) => {
        // Exact match only. `/app/prices` is the prefix of every other tab, so a
        // `startsWith` here would light up Variants on every page in the section.
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
