/**
 * The browser half of `measure-narrow-tables.ts`: one real page of the app, rendered with
 * React 18 and real Polaris, then measured.
 *
 * The routes are the app's own modules -- their `PageShell`, cards, tables and cells --
 * with each loader replaced by the fixture beside it. The server modules they import are
 * stubbed by the bundler, which is safe for the same reason React Router can strip them
 * from the client: a page component never calls one. The campaign page's tables are
 * rendered as components inside the shell and card they sit in there, because that page's
 * loader is the size of the page.
 *
 * React 18 sets a custom element's props as attributes, and so does this, because it is
 * React 18 doing it.
 */

import type { ComponentType, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Card } from "../../app/components/Card";
import { LedgerTable } from "../../app/components/LedgerTable";
import { PageShell } from "../../app/components/PageShell";
import { PreviewTable } from "../../app/components/PreviewTable";
import { RunHistoryTable } from "../../app/components/RunHistoryTable";
import Campaigns from "../../app/routes/app.campaigns._index";
import Variants from "../../app/routes/app.prices._index";
import Baselines from "../../app/routes/app.prices.baselines._index";
import Drift from "../../app/routes/app.prices.drift";
import Live from "../../app/routes/app.prices.live";
import * as fixtures from "./fixtures";
import { measurePage, settled } from "./measure";

function CampaignPage({ children }: { children: ReactNode }) {
  return (
    <PageShell heading="10% off everything" backTo={{ href: "/app/campaigns", label: "Campaigns" }}>
      {children}
    </PageShell>
  );
}

/** Every page #804 names, by the name the runner asks for. */
export const PAGES: Record<string, { Component: ComponentType; data?: unknown }> = {
  live: { Component: Live, data: fixtures.live },
  variants: { Component: Variants, data: fixtures.variants },
  baselines: { Component: Baselines, data: fixtures.baselines },
  drift: { Component: Drift, data: fixtures.drift },
  campaigns: { Component: Campaigns, data: fixtures.campaigns },
  preview: {
    Component: () => (
      <CampaignPage>
        <Card heading="Preview">
          <PreviewTable rows={fixtures.previewRows} markets={fixtures.markets} total={fixtures.previewRows.length} alreadyCorrect={0} />
        </Card>
      </CampaignPage>
    ),
  },
  ledger: {
    Component: () => (
      <CampaignPage>
        <Card heading="Ledger">
          <LedgerTable rows={fixtures.ledgerRows} total={fixtures.ledgerRows.length} />
        </Card>
      </CampaignPage>
    ),
  },
  runs: {
    Component: () => (
      <CampaignPage>
        <Card heading="Run history">
          <RunHistoryTable runs={fixtures.runs} selectedRunId={null} timeZone="UTC" />
        </Card>
      </CampaignPage>
    ),
  },
};

async function main() {
  const name = new URLSearchParams(window.location.search).get("page") ?? "";
  const report = document.getElementById("report") as HTMLElement;
  const page = PAGES[name];
  if (!page) {
    report.textContent = JSON.stringify({ page: name, error: "no such page" });
    return;
  }

  const router = createMemoryRouter([
    { path: "/", Component: page.Component, loader: () => page.data ?? null },
  ]);
  createRoot(document.getElementById("root") as HTMLElement).render(
    <RouterProvider router={router} />,
  );

  // The router loads before it renders, so wait for a table to exist before waiting for
  // tables to settle.
  for (let i = 0; i < 100 && !document.querySelector("s-table"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await settled();
  report.textContent = JSON.stringify(measurePage(name));

  // For a frame that is resized after loading -- by hand, or by a page that embeds this
  // one -- to measure again once the tables have caught up.
  Object.assign(window, { measureNow: async () => (await settled(), measurePage(name)) });
}

main().catch((error: unknown) => {
  const report = document.getElementById("report") as HTMLElement;
  report.textContent = JSON.stringify({ error: String(error) });
});
