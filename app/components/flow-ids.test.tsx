/**
 * The IDs Shopify Flow asks for are on screen, each with a button that copies it (#826).
 *
 * Flow's Start and End actions ask for a campaign ID and "Capture baselines for a
 * segment" asks for a segment ID. The campaign's was only in the address bar; the
 * segment's was nowhere a merchant could see, so the Capture action could not be set up.
 *
 * Rendered rather than grepped: the claim is that a merchant sees the ID and can copy it,
 * and both halves are about the markup a given campaign or segment produces.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignOverviewTab } from "./campaign/CampaignOverviewTab";
import type { CampaignDetailProps } from "./campaign/props";
import { SegmentTable, type SegmentRow } from "./SegmentTable";
import { describeState } from "../lib/lifecycle/transitions";

const CAMPAIGN_ID = "cmub201om05onlp36jmhzd0vy";

/** The loader's payload, as far as the Overview tab reads it. */
const overview = (over: Partial<CampaignDetailProps> = {}) =>
  ({
    lifecycle: describeState("ACTIVE"),
    scheduleText: "Starts 1 Sep 2026, 09:00",
    warnings: [],
    autoEnroll: false,
    enrollPendingAt: false,
    history: [],
    timeZone: "Europe/London",
    note: null,
    fetcher: { Form: "form", state: "idle" },
    busy: false,
    practice: false,
    campaignId: CAMPAIGN_ID,
    // Nothing on record and nothing asked (#1009).
    startConfirmation: { confirmed: null, unconfirmed: null },
    breachPolicy: { policy: "clamp", kept: true, store: "clamp" },
    // Which floors it is planned with: the store's, as every campaign that sets none (#816).
    floors: {
      applied: "At least $5.00",
      whose: "The store's floors, from Settings.",
      unconfirmed: null,
      fields: { neverBelowCost: false, minMarginPercent: "", minPrice: "5.00", policy: "" },
      store: "At least $5.00",
      currency: "USD",
    },
    ...over,
  }) as unknown as CampaignDetailProps;

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<StaticRouter location={`/app/campaigns/${CAMPAIGN_ID}`}>{node}</StaticRouter>);

/** Every button in the markup, by its accessible name. */
const buttonNamed = (html: string, name: string) =>
  [...html.matchAll(/<s-button\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`accessibilityLabel="${name}"`));

describe("the campaign page shows its ID for Flow", () => {
  const html = render(<CampaignOverviewTab {...overview()} />);

  it("labels it for Flow, as the issue asked", () => {
    expect(html).toContain("Campaign ID, used in Shopify Flow");
  });

  it("shows the ID itself, under the label", () => {
    const label = html.indexOf("Campaign ID, used in Shopify Flow");
    const id = html.indexOf(`>${CAMPAIGN_ID}<`);
    expect(id, "the campaign's ID is not on the page").toBeGreaterThan(-1);
    expect(id).toBeGreaterThan(label);
  });

  it("puts a copy button beside it whose accessible name says what it copies", () => {
    const button = buttonNamed(html, "Copy campaign ID");
    expect(button, "no button named “Copy campaign ID”").toBeDefined();
    // Tertiary with an icon, like every quiet control in the app: without the icon a
    // tertiary button renders as plain text (see ActionRow).
    expect(button).toContain('variant="tertiary"');
    expect(button).toContain('icon="clipboard"');
    // Beside the ID, not somewhere else on the tab.
    expect(html).toMatch(new RegExp(`>${CAMPAIGN_ID}</s-text><s-button[^>]*accessibilityLabel="Copy campaign ID"`));
  });

  it("is not offered on a practice campaign, which Flow's Start refuses", () => {
    const practice = render(<CampaignOverviewTab {...overview({ practice: true })} />);
    expect(practice).not.toContain("Campaign ID, used in Shopify Flow");
    expect(practice).not.toContain(CAMPAIGN_ID);
  });
});

describe("Settings → Segments shows each segment's ID", () => {
  const segments: SegmentRow[] = [
    { id: "seg_summer_01", name: "Summer", kind: "DYNAMIC", size: 12, usedBy: [] },
    { id: "seg_outlet_02", name: "Outlet", kind: "FROZEN", size: 3, usedBy: [{ id: "cmp_clearance", name: "Clearance", status: "ACTIVE" }] },
  ];
  const html = render(<SegmentTable segments={segments} Form={"form" as never} busy={false} />);

  it.each(segments)("renders $name's ID in its row", (segment) => {
    const rows = html.split("<s-table-row").slice(1);
    const row = rows.find((r) => r.includes(`>${segment.name}<`));
    expect(row, `no row for ${segment.name}`).toBeDefined();
    expect(row).toContain(`>${segment.id}<`);
  });

  it.each(segments)("gives $name's ID a copy button named for that segment", (segment) => {
    const name = `Copy the segment ID of “${segment.name}”`;
    const button = buttonNamed(html, name);
    expect(button, `no button named ${name}`).toBeDefined();
    expect(html).toMatch(new RegExp(`>${segment.id}</s-text><s-button[^>]*accessibilityLabel="${name}"`));
  });

  it("adds no column for it: the ID sits under the name", () => {
    // `[\s>]`, not `\b`: a word boundary matches `<s-table-header-row` as well.
    const headers = html.match(/<s-table-header[\s>]/g) ?? [];
    expect(headers).toHaveLength(5);
  });
});
