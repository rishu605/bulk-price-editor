/**
 * The page asks for the typed confirmation of a start nobody watches where the start is
 * decided (#1009): "Scheduled and Flow starts" on the Overview tab, and new dates.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { BlastRadius } from "../../lib/campaigns/blast-radius";
import { sourceOf } from "../../lib/testing/source";
import type { CampaignDetailProps } from "./props";
import { ScheduleModals } from "./ScheduleControls";
import { StartConfirmationCard } from "./StartConfirmation";

const radius: BlastRadius = {
  thresholds: { variants: 1_000, changePercent: 50 },
  planned: 8,
  largeChanges: 8,
  largest: { title: "Wool coat", before: "$200.00", after: "$10.00", basisPoints: 9_500, direction: "down" },
  atMinimum: 0,
};
const UNCONFIRMED = "8 prices move more than 50% from their baseline. Nobody has confirmed it by typing “apply”.";

const card = (over: Partial<CampaignDetailProps> = {}) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns/c1">
      <StartConfirmationCard
        {...({
          startConfirmation: { confirmed: null, unconfirmed: UNCONFIRMED },
          preview: { confirm: radius },
          practice: false,
          state: "DRAFT",
          fetcher: { Form: "form", state: "idle" },
          busy: false,
          ...over,
        } as unknown as CampaignDetailProps)}
      />
    </StaticRouter>,
  );

describe("Scheduled and Flow starts", () => {
  it("asks for the word, in the server's sentence, with the largest change's prices beside it", () => {
    const html = card();
    expect(html).toContain("Scheduled and Flow starts");
    expect(html).toContain(UNCONFIRMED);
    expect(html).toContain("Largest change: Wool coat, $200.00 to $10.00.");
    expect(html).toContain('name="intent" value="confirm-start"');
    expect(html).toContain('name="confirmation"');
    expect(html).toContain("Confirm for scheduled and Flow starts");
  });

  it("says who confirmed it and what that covered, with no box while it is covered", () => {
    const html = card({
      startConfirmation: { confirmed: { by: "Staff 7946", at: "15 Oct 2026, 09:00", reach: "8 prices" }, unconfirmed: null },
    } as never);
    expect(html).toContain("Confirmed by Staff 7946, 15 Oct 2026, 09:00: 8 prices.");
    expect(html).toContain("can start it while it reaches no further than that");
    expect(html).not.toContain('name="confirmation"');
  });

  it("is not shown where there is nothing to say, or on a campaign that never starts", () => {
    expect(card({ startConfirmation: { confirmed: null, unconfirmed: null } } as never)).toBe("");
    expect(card({ practice: true })).toBe("");
    expect(card({ state: "CANCELLED" } as never)).toBe("");
  });
});

describe("the editor", () => {
  it("shows the box the save asks with by its button, inside the form that posts it", () => {
    // The action answers a dated campaign that needs the word with `confirm` rather than a
    // redirect; a box outside the form would never post what was typed into it.
    const editor = sourceOf("app/routes/app.campaigns.new.tsx");
    const box = editor.indexOf("<StartConfirmationAsk");
    expect(editor).toMatch(/answer\?\.confirm \? \(\s*<StartConfirmationAsk/);
    expect(box).toBeGreaterThan(editor.indexOf('<Form method="post"'));
    expect(box).toBeLessThan(editor.indexOf("</Form>"));
  });
});

describe("new dates", () => {
  const modals = (confirm: { unconfirmed: string; radius: BlastRadius } | null) =>
    renderToStaticMarkup(
      <ScheduleModals
        campaignName="Black Friday"
        window={{ start: "2026-11-27T09:00", end: "", startText: "27 Nov 2026, 09:00 (UTC)" }}
        confirm={confirm}
        onSave={() => {}}
        onUnschedule={() => {}}
        onCancel={() => {}}
      />,
    );

  it("ask for the word with them when its start would need it", () => {
    const html = modals({ unconfirmed: UNCONFIRMED, radius });
    expect(html).toContain(UNCONFIRMED);
    expect(html).toContain('name="confirmation"');
  });

  it("ask nothing more when it would not", () => {
    expect(modals(null)).not.toContain('name="confirmation"');
  });
});
