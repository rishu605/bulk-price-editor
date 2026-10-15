import { describe, expect, it } from "vitest";

import { notPricedMessage, whyNotPriced, type VariantFacts } from "./not-priced";

const active = { deletedAt: null, status: "ACTIVE", isGiftCard: false };
const priced: VariantFacts = { row: active, excluded: false, inScope: true, hasBaseline: true };

describe("whyNotPriced (#1042)", () => {
  it("is null for a variant in scope with a baseline", () => {
    expect(whyNotPriced(priced, ["ACTIVE"])).toBeNull();
  });

  it("names an archived product's status against the campaign's statuses", () => {
    const archived = { ...priced, row: { ...active, status: "ARCHIVED" }, inScope: false };
    expect(whyNotPriced(archived, ["ACTIVE", "DRAFT"])).toEqual({ reason: "status", status: "ARCHIVED", statuses: ["ACTIVE", "DRAFT"] });
  });

  it("says scope when the status is one the campaign covers, or it covers every status", () => {
    const retagged = { ...priced, inScope: false };
    expect(whyNotPriced(retagged, ["ACTIVE"])).toEqual({ reason: "scope" });
    expect(whyNotPriced({ ...retagged, row: { ...active, status: "ARCHIVED" } }, undefined)).toEqual({ reason: "scope" });
  });

  it("puts an exclusion first, then a deleted variant, then a gift card", () => {
    expect(whyNotPriced({ ...priced, excluded: true, row: null }, ["ACTIVE"])).toEqual({ reason: "excluded" });
    expect(whyNotPriced({ ...priced, row: null, inScope: false }, ["ACTIVE"])).toEqual({ reason: "deleted" });
    expect(whyNotPriced({ ...priced, row: { ...active, deletedAt: new Date() }, inScope: false }, ["ACTIVE"])).toEqual({ reason: "deleted" });
    expect(whyNotPriced({ ...priced, row: { ...active, isGiftCard: true }, inScope: false }, ["ACTIVE"])).toEqual({ reason: "gift-card" });
  });

  it("says baseline for a variant in scope with nothing to compute from", () => {
    expect(whyNotPriced({ ...priced, hasBaseline: false }, ["ACTIVE"])).toEqual({ reason: "baseline" });
  });
});

describe("notPricedMessage (#1042)", () => {
  it("names the variant, the cause and the next action, and says nothing was written", () => {
    const message = notPricedMessage({ reason: "status", status: "ARCHIVED", statuses: ["ACTIVE", "DRAFT"] }, "Summer", '"Blue shirt"');
    expect(message).toMatch(/^"Blue shirt"'s product is archived now, and "Summer" prices only active or draft products/);
    expect(message).toMatch(/Nothing was written and the drift stays open/);
    expect(message).toMatch(/Set the product back to active or draft and put it back again, or choose Keep the change or Leave it for now\.$/);
  });

  it("starts a sentence with a capital for a variant with no title", () => {
    expect(notPricedMessage({ reason: "scope" }, "Summer", "this variant")).toMatch(/^This variant no longer matches "Summer"'s segment or filter/);
  });

  it("phrases every reason", () => {
    for (const reason of ["excluded", "deleted", "gift-card", "scope", "baseline"] as const) {
      expect(notPricedMessage({ reason }, "Summer", "this variant")).toMatch(/drift stays open/);
    }
  });
});
