import { Link, useSearchParams } from "react-router";

export interface CampaignTab {
  id: string;
  label: string;
  /** Hidden entirely when false. An empty tab is a promise of content that is not there. */
  available: boolean;
  /** Shown beside the label — a run count, a drifted-row count. */
  badge?: number;
}

/**
 * The campaign page's tabs.
 *
 * The page had thirteen sections stacked on top of each other, so a merchant asking
 * "did my sale apply?" scrolled past a margin analysis and a ledger to find out.
 *
 * Tabs a campaign has nothing for are not rendered. A DRAFT campaign has no runs, and a
 * "Runs" tab that opens onto an empty state is worse than no tab: it reads as something
 * having gone missing.
 *
 * The state lives in `?tab=`, so an alert or an email can link at the tab that explains
 * the thing it is about, and a merchant reloading the page stays where they were.
 */
export function CampaignTabs({ tabs, current }: { tabs: CampaignTab[]; current: string }) {
  const [params] = useSearchParams();

  return (
    <s-stack direction="inline" gap="base">
      {tabs
        .filter((tab) => tab.available)
        .map((tab) => {
          const next = new URLSearchParams(params);
          next.set("tab", tab.id);
          const label = tab.badge ? `${tab.label} (${tab.badge})` : tab.label;

          return tab.id === current ? (
            <s-text key={tab.id} type="strong">
              {label}
            </s-text>
          ) : (
            <Link key={tab.id} to={`?${next}`} preventScrollReset>
              {label}
            </Link>
          );
        })}
    </s-stack>
  );
}

/** The tab to show, falling back to the first one this campaign actually has. */
export function currentTab(tabs: CampaignTab[], requested: string | null): string {
  const available = tabs.filter((tab) => tab.available);
  if (requested && available.some((tab) => tab.id === requested)) return requested;
  return available[0]?.id ?? "overview";
}
