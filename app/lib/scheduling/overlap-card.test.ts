/**
 * The calendar's overlap card: its tense, and where its one link goes (#1016).
 *
 * #979 put a pair whose campaigns had both finished in the past tense, and left the rest
 * of the card in the present: "Campaigns running at the same time" over two sales that
 * ended in March, and a "See which price each product gets" button that could open a
 * finished campaign, whose page has no prices to compare.
 *
 * Past is now a fact about the overlap rather than about each campaign. Two windows stop
 * overlapping when the first of them closes, so a sale still up beside a weekend sale that
 * was reverted on Sunday *ran* together with it; it does not run together with it now.
 */

import { describe, expect, it } from "vitest";

import { overlapCard, overlapEnded, overlapSentence, type Overlap, type OverlapSide } from "./overlap-card";

const NOW = "2026-10-14T12:00:00.000Z";

const side = (id: string, over: Partial<OverlapSide> = {}): OverlapSide => ({
  id,
  name: id === "a" ? "Spring sale" : "Clearance",
  pricing: false,
  scheduled: false,
  ...over,
});

const overlap = (over: Partial<Overlap> = {}): Overlap => ({
  a: side("a"),
  b: side("b"),
  sharedVariants: 3,
  ended: false,
  ...over,
});

describe("whether an overlap has ended", () => {
  it("has ended once the earlier of the two windows has closed", () => {
    expect(overlapEnded({ endAt: "2026-10-11T23:59:00.000Z" }, { endAt: null }, NOW)).toBe(true);
    expect(overlapEnded({ endAt: null }, { endAt: "2026-10-11T23:59:00.000Z" }, NOW)).toBe(true);
  });

  it("goes on while both are open-ended or still to close", () => {
    expect(overlapEnded({ endAt: null }, { endAt: null }, NOW)).toBe(false);
    expect(overlapEnded({ endAt: "2026-10-20T00:00:00.000Z" }, { endAt: null }, NOW)).toBe(false);
    expect(overlapEnded({ endAt: "2026-10-20T00:00:00.000Z" }, { endAt: "2026-11-01T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("has ended at the instant the first window closes", () => {
    expect(overlapEnded({ endAt: NOW }, { endAt: null }, NOW)).toBe(true);
  });
});

describe("the sentence after the two names", () => {
  it("is in the past once the overlap has ended", () => {
    expect(overlapSentence(overlap({ ended: true }))).toBe("ran together and shared 3 products.");
    expect(overlapSentence(overlap({ ended: true, sharedVariants: 0 }))).toBe("ran together, but had no products in common.");
  });

  it("is in the present while it goes on or is still to come", () => {
    expect(overlapSentence(overlap())).toBe("run together and share 3 products.");
    expect(overlapSentence(overlap({ sharedVariants: 1 }))).toBe("run together and share 1 product.");
    expect(overlapSentence(overlap({ sharedVariants: 0 }))).toBe("run together, but have no products in common.");
  });
});

describe("the card's heading and introduction", () => {
  it("are in the past when every overlap on it has ended", () => {
    const card = overlapCard([overlap({ ended: true }), overlap({ ended: true, sharedVariants: 0 })]);
    expect(card.heading).toBe("Campaigns that ran at the same time");
    expect(card.intro).not.toMatch(/\bwins\b|\bshare\b|preview shows/);
    expect(card.intro).toMatch(/\bwon\b/);
  });

  it("stay in the present while any overlap on it goes on", () => {
    const card = overlapCard([overlap({ ended: true }), overlap()]);
    expect(card.heading).toBe("Campaigns running at the same time");
    expect(card.intro).toMatch(/\bwins\b/);
  });
});

describe("where “See which price each product gets” goes", () => {
  // A campaign's preview plans it against the campaigns pricing now -- `competingCampaigns`
  // -- so the page that shows a pair resolved is one whose *other* campaign is pricing.
  const pricing = { pricing: true };
  const scheduled = { scheduled: true };

  it("goes nowhere when every overlap has ended", () => {
    expect(overlapCard([overlap({ ended: true, a: side("a", pricing), b: side("b", pricing) })]).priceLink).toBeNull();
  });

  it("goes nowhere for a pair that shares no products", () => {
    expect(overlapCard([overlap({ sharedVariants: 0, a: side("a", pricing), b: side("b", pricing) })]).priceLink).toBeNull();
  });

  it("opens the preview of a campaign still pricing when both are", () => {
    expect(overlapCard([overlap({ a: side("a", pricing), b: side("b", pricing) })]).priceLink).toBe(
      "/app/campaigns/a?tab=preview",
    );
  });

  it("opens the scheduled one beside a sale that is up, whose preview plans against that sale", () => {
    expect(overlapCard([overlap({ a: side("a", pricing), b: side("b", scheduled) })]).priceLink).toBe(
      "/app/campaigns/b?tab=preview",
    );
    expect(overlapCard([overlap({ a: side("a", scheduled), b: side("b", pricing) })]).priceLink).toBe(
      "/app/campaigns/a?tab=preview",
    );
  });

  it("goes nowhere for two campaigns that are both still to come, since neither preview plans against the other", () => {
    expect(overlapCard([overlap({ a: side("a", scheduled), b: side("b", scheduled) })]).priceLink).toBeNull();
  });

  it("never opens a campaign that is neither pricing nor still to come", () => {
    // A campaign being reverted: its page compares nothing with the campaign beside it.
    expect(overlapCard([overlap({ a: side("a"), b: side("b", pricing) })]).priceLink).toBeNull();
  });

  it("takes the first overlap it can link, skipping the ones it cannot", () => {
    const card = overlapCard([
      overlap({ ended: true, a: side("a", pricing), b: side("b", pricing) }),
      overlap({ a: side("c", scheduled), b: side("d", pricing) }),
    ]);
    expect(card.priceLink).toBe("/app/campaigns/c?tab=preview");
  });
});
