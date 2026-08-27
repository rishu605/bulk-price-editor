/**
 * Which tab a campaign opens on, and which it does not offer at all.
 *
 * The page had thirteen sections stacked in one column, so "did my sale apply?" meant
 * scrolling past a margin analysis and a ledger. Tabs fix that and introduce a way to
 * lose things: a tab that is not offered hides its content completely, and a `?tab=`
 * pointing at a tab this campaign does not have would render nothing at all.
 *
 * A DRAFT campaign has no runs, no ledger and nothing to revert — three of the five
 * tabs — so the fallback is not an edge case, it is what every new campaign hits.
 */

import { describe, expect, it } from "vitest";

import { currentTab, type CampaignTab } from "./CampaignTabs";

const tabs = (over: Partial<Record<string, boolean>> = {}): CampaignTab[] => [
  { id: "overview", label: "Overview", available: over.overview ?? true },
  { id: "preview", label: "Preview", available: over.preview ?? true },
  { id: "runs", label: "Runs", available: over.runs ?? false },
  { id: "revert", label: "Revert", available: over.revert ?? false },
  { id: "ledger", label: "Ledger", available: over.ledger ?? false },
];

describe("choosing the tab", () => {
  it("honours a deep link, so an alert can point at the tab that explains it", () => {
    expect(currentTab(tabs({ runs: true }), "runs")).toBe("runs");
  });

  it("falls back rather than rendering an empty page", () => {
    // A link to ?tab=runs on a campaign that has never run: the tab is not offered, so
    // selecting it would show a tab bar and nothing beneath it.
    expect(currentTab(tabs(), "runs")).toBe("overview");
  });

  it("falls back on a tab id that does not exist at all", () => {
    expect(currentTab(tabs(), "nonsense")).toBe("overview");
  });

  it("opens on the first tab when none was asked for", () => {
    expect(currentTab(tabs(), null)).toBe("overview");
  });

  it("skips an unavailable first tab rather than selecting it", () => {
    expect(currentTab(tabs({ overview: false }), null)).toBe("preview");
  });

  it("never returns a tab that is not available", () => {
    for (const requested of ["overview", "preview", "runs", "revert", "ledger", null]) {
      const list = tabs({ overview: false, preview: false, ledger: true });
      const chosen = currentTab(list, requested);
      expect(
        list.find((tab) => tab.id === chosen)?.available,
        `${requested} resolved to ${chosen}, which is not offered`,
      ).toBe(true);
    }
  });

  it("degrades to overview when a campaign somehow offers nothing", () => {
    const none = tabs({ overview: false, preview: false });
    expect(currentTab(none, null), "a tab bar with no tabs must still name one").toBe(
      "overview",
    );
  });
});
