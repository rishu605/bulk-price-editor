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

/**
 * The sync step's control comes from the page, not from the step.
 *
 * Capturing baselines is a `POST` from the page the checklist is already on. It used to
 * be written as a link to `/app` — on Home, a button that reloads the page you are
 * looking at and changes nothing, directly above a second black button that did the work
 * under a different name. So the card takes the real control and the step carries no
 * href of its own.
 */
const SYNC = <s-button type="submit">Sync catalogue</s-button>;

const render = (facts: Parameters<typeof onboarding>[0]) =>
  renderToStaticMarkup(<OnboardingCard state={onboarding(facts)} actions={{ sync: SYNC }} />);

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

  it("has no action for that step unless the page supplies one", () => {
    // The step offers no href of its own, so a card rendered without the page's control
    // shows the step and no button — rather than a link back to the page it is on.
    const bare = renderToStaticMarkup(<OnboardingCard state={onboarding(fresh)} />);

    expect(bare).toContain("Capture your baselines");
    expect(bare, "a link to /app is a button that reloads the page you are on").not.toContain(
      'href="/app"',
    );
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

  it("offers no explanation on a completed step either", () => {
    // The one row with nothing to do had a lone "Why?" hanging off its right edge,
    // offering to explain work the merchant had already finished.
    const step = html.slice(
      html.indexOf("Capture your baselines"),
      html.indexOf("Try one in practice mode"),
    );
    expect(step).not.toContain("Why?");
  });
});

describe("how a step is drawn", () => {
  const html = render(fresh);

  it("is a row, not a card", () => {
    // Each step used to be a bordered box holding a stack, which rendered the title, the
    // toggle and the action on three separate lines — nine lines and three borders for
    // three short sentences. The cells of a grid are what put them on one line.
    expect(html).toContain("<s-grid");
    expect(html).not.toContain("borderWidth");
  });

  it("draws the status as a glyph rather than a badge on every row", () => {
    // Three badges to say what three glyphs say, and the two loudest words on the card
    // were "Done" and "Later".
    expect(html).not.toContain("Later");
    expect(html).toContain("<s-icon");
  });

  it("still marks exactly one step as the one to do next", () => {
    expect(html.match(/Next/g)).toHaveLength(1);
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

describe("the checklist reads as a list", () => {
  /**
   * "Why?" and the action shared one grid cell, and a cell sized `auto` is as wide as its
   * contents — so where "Why?" landed depended on how wide *that row's* button happened to
   * be. On the deployed build the three sat at three different x positions about a hundred
   * pixels apart, and the eye read three ragged rows rather than a list.
   *
   * A column each fixes both halves: "Why?" lines up down the card, and the actions share
   * an edge because they share a column.
   */
  const html = render(fresh);

  it("gives Why? and the action a column each", () => {
    expect(html).toMatch(/gridtemplatecolumns="[^"]*auto 1fr auto auto"/i);
  });

  it("does not put them back in one cell", () => {
    // The shape that caused it: both inside a single `ActionRow`. One `ActionRow` per row
    // is still right — it holds the action — but "Why?" is outside it.
    const row = html.slice(html.indexOf("Capture your baselines"));
    const why = row.indexOf("Why?");
    const actionRow = row.indexOf("Sync catalogue");

    expect(why).toBeGreaterThan(-1);
    expect(actionRow).toBeGreaterThan(why);
  });
});

