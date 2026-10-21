/**
 * Every per-row control names its row, so no two controls in one table sound the same
 * (#796).
 *
 * "Leave as it is, checkbox" read N times on the Revert tab -- the table whose job is
 * choosing which hand edits survive -- and Keep / Put back / Leave on every drift row, gave
 * a screen-reader user no way to tell which variant each control acted on.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";
import { choiceName } from "../lib/drift/choice-name";
import { newTabName } from "../lib/ui/new-tab";
import { BaselineTable } from "./BaselineTable";
import { RollbackReportTable } from "./RollbackReportTable";
import { runLedgerName } from "./RunHistoryTable";
import { SegmentTable } from "./SegmentTable";

/** The accessible name of every button, link and checkbox in the markup, in order. */
function controlNames(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/<s-(button|link)\b([^>]*)>([\s\S]*?)<\/s-\1>/g)) {
    const label = match[2].match(/accessibilityLabel="([^"]*)"/);
    names.push(label ? label[1] : match[3].replace(/<[^>]+>/g, "").trim());
  }
  for (const match of html.matchAll(/<s-checkbox\b[^>]*\blabel="([^"]*)"/g)) names.push(match[1]);
  return names;
}

const unique = (names: string[]) => expect(names.length, `duplicates in ${JSON.stringify(names)}`).toBe(new Set(names).size);

describe("per-row controls name their row", () => {
  it("the Revert tab's checkboxes say which edit each one keeps", () => {
    const row = (n: number) => ({ variantGid: `gid://v/${n}`, title: `Jacket ${n} · M`, kind: "drifted" as const, applied: "10.00", live: "12.00", revertsTo: "20.00" });
    const names = controlNames(renderToStaticMarkup(<RollbackReportTable rows={[row(1), row(2)]} />));
    expect(names).toContain("Leave Jacket 1 · M as it is");
    unique(names);
  });

  it("the segments table's Edit and Delete say which segment", () => {
    const segment = (name: string) => ({ id: `seg_${name}`, name, kind: "DYNAMIC", size: 3, usedBy: [] });
    const names = controlNames(
      renderToStaticMarkup(<SegmentTable segments={[segment("Summer"), segment("Outlet")]} Form={"form" as never} busy={false} />),
    );
    expect(names).toEqual(expect.arrayContaining(["Edit Summer", "Delete: Summer", "Edit Outlet", "Delete: Outlet"]));
    unique(names.filter((name) => !name.startsWith("Copy")));
  });

  it("Baselines' History and Shopify buttons say which variant", () => {
    const row = (n: number) => ({
      variantGid: `gid://v/${n}`,
      productGid: `gid://p/${n}`,
      title: `Boots ${n}`,
      sku: null,
      vendor: null,
      baseline: "10.00",
      live: "10.00",
      source: "INSTALL_CAPTURE",
      capturedAt: null,
      diverged: false,
      adminUrl: "https://example.invalid",
    });
    const names = controlNames(renderToStaticMarkup(<BaselineTable rows={[row(1), row(2)]} onShowHistory={() => {}} />));
    // The Shopify link opens a new tab, and its name says so (#798).
    expect(names).toEqual(
      expect.arrayContaining(["Baseline history of Boots 1", newTabName("Open Boots 2 in Shopify")]),
    );
    unique(names);
  });

  it("drift's three choices name the variant, and Keep says it rebaselines", () => {
    const names = (["adopt", "reassert", "ignore"] as const).flatMap((choice) => [choiceName(choice, "Hat · S"), choiceName(choice, "Hat · M")]);
    unique(names);
    expect(choiceName("adopt", "Hat · S")).toMatch(/new baseline/);
  });

  it("each run's View ledger says which run", () => {
    const a = runLedgerName({ kind: "APPLY", finishedAt: "2026-10-01T10:00:00.000Z" }, "UTC");
    const b = runLedgerName({ kind: "REVERT", finishedAt: "2026-10-02T10:00:00.000Z" }, "UTC");
    expect(a).toBe("View the ledger of the apply run that finished 1 Oct 2026, 10:00");
    expect(a).not.toBe(b);
  });

  it("the controls rendered inside routes carry their row's name too", () => {
    expect(sourceOf("app/routes/app.prices.drift.tsx")).toContain("accessibilityLabel={choiceName(choice.value, event.title)}");
    expect(sourceOf("app/components/campaign/CampaignLedgerTab.tsx")).toContain("accessibilityLabel={`Revert ${row.title}`}");
    expect(sourceOf("app/components/campaign/CampaignListView.tsx")).toContain("accessibilityLabel={`Duplicate ${campaign.name}`}");
    expect(sourceOf("app/components/RunHistoryTable.tsx")).toContain("accessibilityLabel={runLedgerName(run, timeZone)}");
  });
});
