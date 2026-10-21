/**
 * The guard on the most destructive thing this app can do.
 *
 * Recapture replaces every baseline in scope with today's live price. Run it during a
 * sale and the sale prices become the merchant's normal prices — permanently, for every
 * campaign afterwards. There is no undo that makes that not have happened.
 */

import { describe, expect, it } from "vitest";

import { assessRecapture, confirmationMatches, DANGEROUS_PHRASE, recapturedMessage, replaceLabel, scopeSentence } from "./recapture";

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
    expect(assessment.warning).toContain("500 of these 1,000");
  });

  it("groups its counts and agrees with one (#759)", () => {
    // Live: "1 of these 3669 variants are on sale right now".
    const one = assessRecapture(3_669, [{ campaignId: "c1", campaignName: "Summer Sale", variants: 1 }]);
    expect(one.warning).toContain("1 of these 3,669 variants is on sale right now");

    const many = assessRecapture(120_000, [{ campaignId: "c1", campaignName: "Summer Sale", variants: 4_200 }]);
    expect(many.warning).toContain("4,200 of these 120,000 variants are on sale right now");
    expect(many.warning).toContain('"Summer Sale" (4,200)');
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

describe("the page's counts (#759)", () => {
  it("says how many variants are in scope, grouped and singular for one", () => {
    expect(scopeSentence(3_669)).toBe("3,669 variants in scope.");
    expect(scopeSentence(1)).toBe("1 variant in scope.");
  });

  it("labels the button with the grouped count", () => {
    // Live: "Replace 3669 baselines".
    expect(replaceLabel(3_669)).toBe("Replace 3,669 baselines");
    expect(replaceLabel(1)).toBe("Replace 1 baseline");
  });

  it("reports what it did in grouped counts that agree with one", () => {
    expect(recapturedMessage({ captured: 3_669, scope: 3_669, superseded: 1_200, alreadyCurrent: 0 })).toBe(
      "Recaptured 3,669 baselines across 3,669 variants, superseding 1,200.",
    );
    expect(recapturedMessage({ captured: 1, scope: 2, superseded: 0, alreadyCurrent: 1 })).toBe(
      "Recaptured 1 baseline across 2 variants. 1 was already correct.",
    );
    expect(recapturedMessage({ captured: 0, scope: 2_000, superseded: 0, alreadyCurrent: 2_000 })).toContain(
      "2,000 were already correct.",
    );
  });

  // The page and Flow answer with this one sentence, wholesale prices included (#1092).
  it("counts the wholesale prices recaptured with their quantity breaks, and names any left as they were", () => {
    expect(recapturedMessage({ captured: 6, scope: 3, superseded: 6, alreadyCurrent: 0, wholesale: 1, wholesaleLeft: 0 })).toBe(
      "Recaptured 6 baselines across 3 variants, superseding 6, including 1 wholesale price with its quantity breaks.",
    );
    expect(recapturedMessage({ captured: 3, scope: 3, superseded: 3, alreadyCurrent: 0, wholesale: 0, wholesaleLeft: 2 })).toBe(
      "Recaptured 3 baselines across 3 variants, superseding 3. 2 wholesale prices were left as they were: " +
        "their quantity breaks could not be read from Shopify. Recapture again to include them.",
    );
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
