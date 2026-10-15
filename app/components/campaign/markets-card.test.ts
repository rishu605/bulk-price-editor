/**
 * The Markets card blames a guardrail only for what a guardrail did (#844).
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";

describe("the preview's Markets card", () => {
  const card = sourceOf("app/components/campaign/CampaignPreviewTab.tsx");

  it("counts only rows a guardrail raised as a guardrail's doing", () => {
    expect(card).toContain('A guardrail raises {countOf(market.clamped, "variant")} to its floor here.');
    expect(card, "skips are blamed on a guardrail again").not.toContain("market.clamped + market.skipped");
  });
});
