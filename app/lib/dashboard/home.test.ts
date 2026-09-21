/**
 * The decisions Home makes about itself.
 *
 * Each exists because of a way the page had previously embarrassed itself, and until they
 * were extracted every one was an untested conditional in JSX. The `live` rule was
 * mutated to `true` during review of the change that introduced it and the whole suite
 * passed — which is how a page goes back to opening with four zeroes.
 *
 * It went back anyway. The guard that replaced the unconditional render was
 * `campaigns > 0 || hasRun`, and `campaigns` counts drafts, so the four zeroes returned
 * for every shop that made one — which is every shop that follows the product's own
 * advice. The cases below are written in terms of the tiles, because that is the only
 * way the guard and the thing it guards cannot drift apart again.
 */

import { describe, expect, it } from "vitest";

import { homeSections } from "./home";

const shop = (over: Partial<Parameters<typeof homeSections>[0]> = {}) =>
  homeSections({
    neverSynced: false,
    running: 0,
    scheduled: 0,
    needsAttention: 0,
    driftOpen: 0,
    drafts: 0,
    hasRun: false,
    onboardingComplete: false,
    ...over,
  });

describe("a shop that has just installed", () => {
  const sections = shop({ neverSynced: true });

  it("is not shown a catalogue it has not synced", () => {
    expect(sections.catalogue).toBe(false);
  });

  it("is not shown four counters reading zero", () => {
    expect(sections.live).toBe(false);
  });

  it("is not shown an empty state either, because the checklist is the page", () => {
    expect(sections.emptyState).toBe(false);
  });
});

describe("a shop part-way through the checklist", () => {
  const sections = shop();

  it("still gets no live section", () => {
    expect(sections.live).toBe(false);
  });

  it("leaves the black button to the checklist's own next step", () => {
    expect(sections.createIsPrimary).toBe(false);
  });
});

describe("a shop whose only campaign is a draft", () => {
  // The state every merchant passes through: quick create says "Creates a draft", and
  // the editor's primary button is "Create and preview".
  const sections = shop({ drafts: 1 });

  it("is not shown four tiles reading zero", () => {
    expect(
      sections.live,
      "a draft is not a small amount of live, and four zeroes is what this guard is for",
    ).toBe(false);
  });

  it("is told about the draft instead", () => {
    expect(sections.drafts).toBe(true);
  });

  it("is not also told that nothing is running", () => {
    // Two blocks answering the same question, one of them less usefully.
    expect(shop({ drafts: 1, onboardingComplete: true }).emptyState).toBe(false);
  });
});

describe("a shop with something to report", () => {
  it("shows the live section for a campaign that is running", () => {
    expect(shop({ running: 1 }).live).toBe(true);
  });

  it("shows it for one that is scheduled", () => {
    expect(shop({ scheduled: 1 }).live).toBe(true);
  });

  it("shows it for one that needs a decision", () => {
    expect(shop({ needsAttention: 1 }).live).toBe(true);
  });

  it("shows it for prices changed outside the app", () => {
    // The fourth tile counts something no campaign state covers, so it turns the
    // section on by itself.
    expect(shop({ driftOpen: 1 }).live).toBe(true);
  });

  it("shows it for a run that happened even if the campaign is gone", () => {
    // The last run is a thing a merchant opens the page to check, and deleting the
    // campaign does not make it not have happened.
    expect(shop({ hasRun: true }).live).toBe(true);
  });

  it("does not add a draft line beside it", () => {
    // The drafts are reachable from the campaigns index; the page is answering "what is
    // live" and a draft is not.
    expect(shop({ running: 1, drafts: 4 }).drafts).toBe(false);
  });
});

describe("a shop that finished the checklist and deleted its campaigns", () => {
  const sections = shop({ onboardingComplete: true });

  it("gets the empty state, which is the one case the checklist cannot cover", () => {
    expect(sections.emptyState).toBe(true);
  });

  it("is offered quick create, because there is a catalogue to price", () => {
    expect(sections.quickCreate).toBe(true);
  });

  it("does not get a black Create campaign, because quick create is the black one", () => {
    // Quick create *is* creating a campaign, for the case that covers most of them. With
    // both on the page it is the one worth pointing at, and two black buttons point at
    // nothing — which is the same rule that kept Create quiet while the checklist was up.
    expect(sections.createIsPrimary).toBe(false);
  });
});

describe("quick create needs something to price and nothing else asking for attention", () => {
  it("is not offered before the first sync", () => {
    expect(shop({ neverSynced: true, onboardingComplete: true }).quickCreate).toBe(false);
  });

  it("is not offered while the checklist is still telling the merchant what to do", () => {
    // A merchant three steps into being led somewhere does not need a fourth thing to do
    // offered beside it.
    expect(shop({ onboardingComplete: false }).quickCreate).toBe(false);
  });
});

describe("whatever the shop", () => {
  const every = [
    shop({ neverSynced: true }),
    shop(),
    shop({ drafts: 2 }),
    shop({ running: 1 }),
    shop({ scheduled: 3 }),
    shop({ driftOpen: 7 }),
    shop({ hasRun: true }),
    shop({ onboardingComplete: true }),
    shop({ onboardingComplete: true, running: 3, hasRun: true }),
    shop({ onboardingComplete: true, drafts: 1 }),
  ];

  it("never shows the empty state and the live section together", () => {
    // They answer the same question, and a page rendering both says "nothing is running"
    // directly above a list of what is running.
    expect(every.filter((sections) => sections.emptyState && sections.live)).toEqual([]);
  });

  it("never shows the draft line and the live section together", () => {
    expect(every.filter((sections) => sections.drafts && sections.live)).toEqual([]);
  });

  it("never shows the draft line and the empty state together", () => {
    expect(every.filter((sections) => sections.drafts && sections.emptyState)).toEqual([]);
  });
});
