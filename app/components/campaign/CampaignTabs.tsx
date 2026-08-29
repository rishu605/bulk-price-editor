import { useSearchParams } from "react-router";

import { TabBar } from "../TabBar";

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
 *
 * The bar is `TabBar`, the same one the section nav and the campaigns index use. This
 * was a bold word beside a blue link until then -- which reads as a sentence containing
 * a link, not as a choice between five views of a campaign.
 */
export function CampaignTabs({ tabs, current }: { tabs: CampaignTab[]; current: string }) {
  const [params] = useSearchParams();

  return (
    <TabBar
      label="Campaign"
      // These swap a panel on the same route. Jumping to the top of the page on every
      // switch would throw away where the merchant was reading.
      preventScrollReset
      tabs={tabs
        .filter((tab) => tab.available)
        .map((tab) => {
          const next = new URLSearchParams(params);
          next.set("tab", tab.id);

          return {
            label: tab.label,
            badge: tab.badge,
            current: tab.id === current,
            href: `?${next}`,
          };
        })}
    />
  );
}

/** The tab to show, falling back to the first one this campaign actually has. */
export function currentTab(tabs: CampaignTab[], requested: string | null): string {
  const available = tabs.filter((tab) => tab.available);
  if (requested && available.some((tab) => tab.id === requested)) return requested;
  return available[0]?.id ?? "overview";
}

/**
 * Which tabs this campaign has anything to put in.
 *
 * Beside `CampaignTabs` rather than in the route, because it is the same decision the
 * component renders and the route had no other reason to hold it. A DRAFT campaign has no
 * runs, and a Runs tab opening onto an empty state reads as something having gone missing
 * rather than as something that has not happened yet.
 */
export function tabsFor({
  runs,
  rollback,
  ledger,
}: {
  runs: unknown[];
  rollback: { counts: { total: number; drifted: number } } | null;
  ledger: unknown[];
}): CampaignTab[] {
  return [
    { id: "overview", label: "Overview", available: true },
    { id: "preview", label: "Preview", available: true },
    { id: "runs", label: "Runs", available: runs.length > 0, badge: runs.length },
    {
      id: "revert",
      label: "Revert",
      available: Boolean(rollback && rollback.counts.total > 0),
      // Drifted rows are the reason to open this tab rather than press the button, so
      // the count belongs on the label.
      badge: rollback?.counts.drifted || undefined,
    },
    { id: "ledger", label: "Ledger", available: ledger.length > 0, badge: ledger.length },
  ];
}
