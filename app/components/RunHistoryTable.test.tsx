/**
 * "View ledger" opens the Ledger tab on that run (#724).
 *
 * The link was `?run=<id>`, which replaces the whole query: `tab=runs` was dropped, the page
 * fell back to its first tab, and the merchant landed on Overview.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { currentTab, tabsFor } from "./campaign/CampaignTabs";
import { ledgerHref, RunHistoryTable } from "./RunHistoryTable";
import type { RunSummary } from "../services/campaigns/index.server";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "run_2",
  kind: "APPLY",
  status: "COMPLETED",
  planned: 3,
  verified: 3,
  failed: 0,
  skipped: 0,
  startedAt: "2026-10-14T10:00:00.000Z",
  finishedAt: "2026-10-14T10:01:00.000Z",
  ...over,
});

function rendered(url: string, runs: RunSummary[], selectedRunId: string | null) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <RunHistoryTable runs={runs} selectedRunId={selectedRunId} timeZone="UTC" />
    </MemoryRouter>,
  );
}

describe("View ledger", () => {
  it("links to the Ledger tab on that run, keeping the page's other parameters", () => {
    const html = rendered("/app/campaigns/c1?tab=runs&from=list", [run({ id: "run_1" }), run()], "run_1");
    const href = /href="([^"]+)"[^>]*>View ledger/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    expect(href, "no View ledger link").toBeDefined();

    const query = new URLSearchParams(href!.replace(/^\?/, ""));
    expect(query.get("run")).toBe("run_2");
    expect(query.get("from")).toBe("list");

    // The tab it names is the one the page shows, for a run with a ledger.
    const tabs = tabsFor({ runs: [run()], rollback: null, ledger: [{}] });
    expect(currentTab(tabs, query.get("tab"))).toBe("ledger");
  });

  it("merges into the current query rather than replacing it", () => {
    expect(ledgerHref(new URLSearchParams("tab=runs&run=old&x=1"), "new")).toBe("?tab=ledger&run=new&x=1");
  });

  it("is not offered for a run that wrote nothing, which has no ledger to open", () => {
    const html = rendered("/app/campaigns/c1?tab=runs", [run({ id: "run_1" }), run({ planned: 0, skipped: 0 })], "run_1");
    expect(html).not.toContain("View ledger");
    expect(html).toContain("Nothing written");
  });
});

describe("each run's email (#1123)", () => {
  it("says where a run's email went", () => {
    const html = rendered("/app/campaigns/c1?tab=runs", [run({ email: { text: "Emailed ops@shop.com", toSettings: false } })], null);
    expect(html).toContain("Emailed ops@shop.com");
  });

  it("links to Settings when the reason is one the merchant can change there", () => {
    const html = rendered(
      "/app/campaigns/c1?tab=runs",
      [run({ email: { text: "No email: no address was saved", toSettings: true } })],
      null,
    );
    expect(html).toMatch(/No email: no address was saved[^<]*<[^>]*>?.*href="\/app\/settings"/s);
  });

  it("shows a run from before the record as blank, not as unsent", () => {
    const html = rendered("/app/campaigns/c1?tab=runs", [run({ email: null })], null);
    expect(html).not.toContain("No email");
    expect(html).not.toContain("Emailed");
  });
});
