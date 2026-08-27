/**
 * The sidebar's activity list, which was five identical lines.
 *
 * `market.added · Scheduler · 27/08/2026, 12:40:38`, five times, in a column 22rem wide.
 * Each of the three problems is fixed in the rendering rather than in the query, because
 * the data was never wrong — the audit log is right to store machine strings and exact
 * timestamps, and right to record every market it added.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityFeed } from "./ActivityFeed";

const NOW = "2026-08-27T15:00:00.000Z";

const render = (entries: Array<{ id: string; actor: string | null; action: string; at: string }>) =>
  renderToStaticMarkup(<ActivityFeed entries={entries} now={NOW} timeZone="Europe/London" />);

const scheduled = (id: string, action: string, at: string) => ({ id, actor: null, action, at });

describe("a sync that added several markets", () => {
  const html = render([
    scheduled("1", "market.added", "2026-08-27T13:00:00.000Z"),
    scheduled("2", "market.added", "2026-08-27T13:00:00.000Z"),
    scheduled("3", "market.added", "2026-08-27T12:59:59.000Z"),
  ]);

  it("says it once, with a count", () => {
    expect(html).toContain("×3");
    expect(html.match(/Market added/g)).toHaveLength(1);
  });

  it("never shows the merchant the machine string", () => {
    expect(html).not.toContain("market.added");
  });

  it("says the time is the latest of the run rather than implying it is the only one", () => {
    expect(html).toContain("latest");
    expect(html).toContain("2 hours ago");
  });

  it("still says who, because that is half of what an audit trail is for", () => {
    expect(html).toContain("Scheduler");
  });
});

describe("a mixed log", () => {
  const html = render([
    scheduled("1", "market.added", "2026-08-27T14:30:00.000Z"),
    { id: "2", actor: "staff:8812", action: "campaign.transition", at: "2026-08-27T09:00:00.000Z" },
    scheduled("3", "market.added", "2026-08-27T08:00:00.000Z"),
  ]);

  it("keeps the two separated events separate, in order", () => {
    // Folding by action across the whole list would move the older market entry up next
    // to the newer one and imply they happened together.
    expect(html.match(/Market added/g)).toHaveLength(2);
    expect(html).not.toContain("×");
  });

  it("attributes staff work to staff", () => {
    expect(html).toContain("Staff 8812");
  });

  it("times each row relative to when the page was loaded", () => {
    expect(html).toContain("30 minutes ago");
    expect(html).toContain("6 hours ago");
  });
});

describe("an empty log", () => {
  it("renders nothing rather than an empty state the card already provides", () => {
    // The card that holds this is only rendered when there is something to put in it.
    expect(render([])).not.toContain("s-icon");
  });
});
