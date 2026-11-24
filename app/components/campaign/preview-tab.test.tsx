/**
 * The Preview tab says how a run will go in the merchant's words (#759).
 *
 * It printed the planner's decision verbatim -- "Write path: sync — 2 rows is under the
 * 1000-row threshold and fits the available rate-limit budget; sync avoids bulk queue
 * latency." -- which is a sentence for whoever wrote `selectWritePath`. What a merchant can
 * use from it is how long the run takes and whether it carries on without them, and the
 * Apply dialog already says exactly that.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignPreviewTab } from "./CampaignPreviewTab";
import type { CampaignDetailProps } from "./props";

const props = (preview: Record<string, unknown>) =>
  ({
    preview: {
      campaignId: "c1",
      name: "Autumn sale",
      status: "DRAFT",
      counts: { planned: 2, noop: 0, skipped: 0, clamped: 0, clampedToMinimum: 0 },
      rows: [],
      writePath: "sync",
      writePathReason:
        "2 rows is under the 1000-row threshold and fits the available rate-limit budget; sync avoids bulk queue latency.",
      markets: [],
      margin: null,
      blastRadius: false,
      staleBaselines: 0,
      ...preview,
    },
    approval: { required: false, state: "none" },
    fetcher: { Form: "form", state: "idle" },
    busy: false,
    // The store's floors and policy, as every campaign that sets none (#816).
    floors: { applied: "At least $5.00", whose: "The store's floors, from Settings.", unconfirmed: null },
    breachPolicy: { policy: "clamp", kept: false, store: "clamp" },
  }) as unknown as CampaignDetailProps;

const render = (preview: Record<string, unknown>) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns/c1?tab=preview">
      <CampaignPreviewTab {...props(preview)} />
    </StaticRouter>,
  );

/** The engine's vocabulary, which the tab printed and the merchant cannot act on. */
const ENGINE = /write path|threshold|rate-limit|budget|latency|\bsync\b|\bbulk\b/i;

describe("how the run will go", () => {
  it("says a small run is written while the merchant waits, without the planner's reasoning", () => {
    const html = render({});

    expect(html).toContain("2 variants, written while you wait");
    expect(html).not.toMatch(ENGINE);
  });

  it("says a large run carries on in the background", () => {
    const html = render({
      counts: { planned: 50_000, noop: 0, skipped: 0, clamped: 0, clampedToMinimum: 0 },
      writePath: "bulk",
      writePathReason: "50000 rows exceeds the 1000-row threshold; bulk operations carry no rate-limit cost.",
    });

    expect(html).toContain("50,000 variants");
    expect(html).toContain("in the background");
    expect(html).toContain("You can leave this page");
    expect(html).not.toMatch(ENGINE);
  });

  it("says nothing about timing when a guardrail blocked the plan", () => {
    const html = render({
      writePath: "none",
      writePathReason: "Blocked before planning completed.",
      blocked: { reason: "below-floor", variantGid: "gid://shopify/ProductVariant/1", message: "A guardrail would stop it." },
    });

    expect(html).not.toContain("while you wait");
    expect(html).not.toContain("Blocked before planning completed");
  });
});
