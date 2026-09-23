import { describe, expect, it } from "vitest";

import { pricingPlansUrl } from "./pricing-plans";

describe("the link to Shopify's plan picker", () => {
  it("is an App Bridge admin path, so it resolves against the merchant's own admin", () => {
    expect(pricingPlansUrl("anchor-pricing")).toBe(
      "shopify://admin/charges/anchor-pricing/pricing_plans",
    );
  });

  it("is absent rather than wrong when the handle is unknown", () => {
    // The loader falls back to null when the query fails, and a dead pricing link on the
    // one screen where somebody decided to pay reads as a broken app.
    for (const missing of [null, undefined, "", "   "]) {
      expect(pricingPlansUrl(missing)).toBeNull();
    }
  });

  it("refuses anything that is not a handle", () => {
    // Not defensiveness for its own sake: the value is interpolated into a URL, and the
    // only thing that should reach it is what the Admin API returned.
    for (const wrong of [
      "Anchor",
      "anchor pricing",
      "../../settings",
      "anchor/pricing_plans",
      "-anchor",
      "https://example.com",
    ]) {
      expect(pricingPlansUrl(wrong), wrong).toBeNull();
    }
  });
});
