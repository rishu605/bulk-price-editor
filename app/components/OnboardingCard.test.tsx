/**
 * The first screen after installing, and how much it says before it asks anything.
 *
 * The checklist used to render every step's explanation at once — roughly 120 words
 * before the merchant reached a link. The explanations are good, and the baseline
 * concept genuinely needs teaching; the mistake was teaching all of it before being
 * asked.
 *
 * Two things must not be lost in making it compact: the reassurance that nothing is
 * written yet, and the fact that a completed step offers no button. Redoing the first
 * step recaptures baselines, which mid-sale makes the sale prices somebody's new
 * normal — permanently.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OnboardingCard } from "./OnboardingCard";
import { onboarding } from "../lib/onboarding/steps";

const render = (facts: Parameters<typeof onboarding>[0]) =>
  renderToStaticMarkup(<OnboardingCard state={onboarding(facts)} />);

const fresh = {
  hasBaselines: false,
  hasCampaign: false,
  hasPracticed: false,
  hasCleanRun: false,
};

describe("a brand new shop", () => {
  const html = render(fresh);

  it("does not open with a wall of explanation", () => {
    // Every step's `detail` is a paragraph. Rendering them all is what made this a wall.
    const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    expect(words, "the first screen after install should not be an essay").toBeLessThan(60);
  });

  it("still says nothing is written yet, which is the reassurance that earns trust", () => {
    expect(html).toMatch(/changes a price until you apply/i);
  });

  it("shows progress, so the checklist reads as finishable", () => {
    expect(html).toMatch(/0 of \d+ done/);
  });

  it("keeps the teaching available rather than deleting it", () => {
    expect(html).toContain("Why?");
  });

  it("leads with the next action", () => {
    expect(html).toContain("Sync catalogue");
  });

  it("keeps each step's Why with its own step, not the one below", () => {
    // The row wraps on a narrow column. With the toggle last it wrapped onto its own
    // line and read as belonging to the next step — an explanation attached to the
    // wrong step is worse than no explanation.
    const step = html.slice(html.indexOf("Capture your baselines"));
    expect(
      step.indexOf("Why?") < step.indexOf("Sync catalogue"),
      "Why? must come before the action so the action is what wraps",
    ).toBe(true);
  });
});

describe("a shop part-way through", () => {
  const html = render({ ...fresh, hasBaselines: true });

  it("counts what is actually done, not what was clicked past", () => {
    expect(html).toMatch(/1 of \d+ done/);
  });

  it("offers no button on a completed step", () => {
    // Redoing the first step recaptures baselines. Mid-sale that makes the sale prices
    // the new normal, permanently — so a finished step must not invite a repeat.
    expect(html).not.toContain("Sync catalogue");
  });
});

describe("a shop that has finished", () => {
  it("retires the card entirely", () => {
    expect(
      render({
        hasBaselines: true,
        hasCampaign: true,
        hasPracticed: true,
        hasCleanRun: true,
      }),
    ).toBe("");
  });
});
