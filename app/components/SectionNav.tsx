import { Link, useLocation } from "react-router";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * Sub-navigation for a section that gathers several former top-level routes.
 *
 * Deliberately plain links rather than tabs. The tabbed treatment belongs with the
 * redesign of each section, and shipping half of it here would mean two different
 * navigation idioms in the app at once — which is the problem this whole epic exists
 * to fix, in miniature.
 */
export function SectionNav({ tabs }: { tabs: SectionTab[] }) {
  const { pathname } = useLocation();

  return (
    <s-stack direction="inline" gap="base">
      {tabs.map((tab) => {
        // Exact match, or a child of this tab. The section root would otherwise light
        // up on every page in the section.
        const current =
          pathname === tab.href || (tab.href !== tabs[0]?.href && pathname.startsWith(`${tab.href}/`));

        return current ? (
          <s-text key={tab.href} type="strong">
            {tab.label}
          </s-text>
        ) : (
          <Link key={tab.href} to={tab.href}>
            {tab.label}
          </Link>
        );
      })}
    </s-stack>
  );
}
