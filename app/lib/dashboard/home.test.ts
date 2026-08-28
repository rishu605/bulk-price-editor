/**
 * The decisions Home makes about itself.
 *
 * Each exists because of a way the page had previously embarrassed itself, and until now
 * every one was an untested conditional in JSX. The `live` rule was mutated to `true`
 * during review of the change that introduced it and the whole suite passed — which is
 * how a page goes back to opening with four zeroes.
 */

import { describe, expect, it } from "vitest";

import { homeSections } from "./home";

const shop = (over: Partial<Parameters<typeof homeSections>[0]> = {}) =>
  homeSections({
    neverSynced: false,
    campaigns: 0,
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
  const sections = shop({ campaigns: 0 });

  it("still gets no live section", () => {
    expect(sections.live).toBe(false);
  });

  it("leaves the black button to the checklist's own next step", () => {
    expect(sections.createIsPrimary).toBe(false);
  });
});

describe("a shop with something to report", () => {
  it("shows the live section for a campaign that exists", () => {
    expect(shop({ campaigns: 1 }).live).toBe(true);
  });

  it("shows it for a run that happened even if the campaign is gone", () => {
    // The last run is a thing a merchant opens the page to check, and deleting the
    // campaign does not make it not have happened.
    expect(shop({ campaigns: 0, hasRun: true }).live).toBe(true);
  });
});

describe("a shop that finished the checklist and deleted its campaigns", () => {
  const sections = shop({ onboardingComplete: true });

  it("gets the empty state, which is the one case the checklist cannot cover", () => {
    expect(sections.emptyState).toBe(true);
  });

  it("gets a black Create campaign, because nothing else is pointing anywhere", () => {
    expect(sections.createIsPrimary).toBe(true);
  });
});

describe("whatever the shop", () => {
  const every = [
    shop({ neverSynced: true }),
    shop(),
    shop({ campaigns: 1 }),
    shop({ hasRun: true }),
    shop({ onboardingComplete: true }),
    shop({ onboardingComplete: true, campaigns: 3, hasRun: true }),
  ];

  it("never shows the empty state and the live section together", () => {
    // They answer the same question, and a page rendering both says "nothing is running"
    // directly above a list of what is running.
    expect(every.filter((sections) => sections.emptyState && sections.live)).toEqual([]);
  });
});
