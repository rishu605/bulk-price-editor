/**
 * The guard on the most destructive thing this app can do.
 *
 * Recapture replaces every baseline in scope with today's live price. Run it during a
 * sale and the sale prices become the merchant's normal prices — permanently, for every
 * campaign afterwards. There is no undo that makes that not have happened.
 */

import { describe, expect, it } from "vitest";

import { assessRecapture, confirmationMatches, DANGEROUS_PHRASE } from "./recapture";

describe("assessRecapture", () => {
  it("asks for nothing extra when no campaign is running", () => {
    // Demanding a typed phrase every time is how a merchant learns to type it without
    // reading, and then types it on the day it mattered.
    const assessment = assessRecapture(1_200, []);
    expect(assessment.risk).toBe("safe");
    expect(assessment.confirmationPhrase).toBeNull();
    expect(assessment.warning).toBeNull();
  });

  it("names each campaign and how many variants it covers", () => {
    // "This will affect 412 products in Summer Sale" is a fact somebody can act on.
    // "Some campaigns may be affected" is a dialog people click through.
    const assessment = assessRecapture(1_000, [
      { campaignId: "c1", campaignName: "Summer Sale", variants: 412 },
      { campaignId: "c2", campaignName: "Clearance", variants: 88 },
    ]);

    expect(assessment.risk).toBe("overlaps-active-campaign");
    expect(assessment.warning).toContain("Summer Sale");
    expect(assessment.warning).toContain("412");
    expect(assessment.warning).toContain("Clearance");
    expect(assessment.warning).toContain("500 of these 1000");
  });

  it("says what actually goes wrong, not that it is dangerous", () => {
    const { warning } = assessRecapture(10, [
      { campaignId: "c1", campaignName: "Sale", variants: 10 },
    ]);
    expect(warning).toContain("new normal");
    expect(warning).toContain("permanently");
    // The remedy, not just the hazard.
    expect(warning).toContain("Revert those campaigns first");
  });

  it("ignores a campaign that overlaps no variants in scope", () => {
    // Running elsewhere in the catalogue is not a reason to alarm somebody recapturing
    // a segment it does not touch.
    const assessment = assessRecapture(50, [
      { campaignId: "c1", campaignName: "Elsewhere", variants: 0 },
    ]);
    expect(assessment.risk).toBe("safe");
    expect(assessment.overlaps).toEqual([]);
  });
});

describe("confirmationMatches", () => {
  it("accepts the phrase whatever the capitalisation", () => {
    // The requirement is that they read the sentence and type the words, not that they
    // reproduce capitalisation. Strictness turns a safety check into a puzzle, and a
    // puzzle gets copy-pasted.
    expect(confirmationMatches(DANGEROUS_PHRASE, DANGEROUS_PHRASE)).toBe(true);
    expect(confirmationMatches("replace baselines", DANGEROUS_PHRASE)).toBe(true);
    expect(confirmationMatches("  Replace Baselines  ", DANGEROUS_PHRASE)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(confirmationMatches("yes", DANGEROUS_PHRASE)).toBe(false);
    expect(confirmationMatches("", DANGEROUS_PHRASE)).toBe(false);
    expect(confirmationMatches("REPLACE BASELINE", DANGEROUS_PHRASE)).toBe(false);
  });

  it("requires nothing when nothing is at risk", () => {
    expect(confirmationMatches("", null)).toBe(true);
  });
});
