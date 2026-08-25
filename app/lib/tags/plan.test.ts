/**
 * Tag ownership.
 *
 * Adding a tag is harmless. Removing one is not: a merchant who already had "SALE" on
 * a product for their own reasons, and watched a campaign's revert delete it, has lost
 * merchandising the app never created and has nothing explaining where it went.
 *
 * So every test here is really the same question asked from a different angle — is
 * this tag ours to take back?
 */

import { describe, expect, it } from "vitest";

import { planTagRemoval, planTagsFor } from "./plan";

describe("planTagsFor", () => {
  it("adds tags the product does not have", () => {
    const plan = planTagsFor("p1", ["SALE", "SUMMER"], ["NEW"]);
    expect(plan.toAdd).toEqual(["SALE", "SUMMER"]);
    expect(plan.alreadyPresent).toEqual([]);
  });

  it("never claims a tag the product already carried", () => {
    // The one that matters. `tagsAdd` is a no-op here, so removing it later would
    // delete the merchant's own tag.
    const plan = planTagsFor("p1", ["SALE"], ["SALE", "NEW"]);
    expect(plan.toAdd).toEqual([]);
    expect(plan.alreadyPresent).toEqual(["SALE"]);
  });

  it("compares case-insensitively, as Shopify does", () => {
    // Shopify treats "Sale" and "sale" as one tag. A case-sensitive comparison would
    // record "Sale" as ours and strip the merchant's "sale" on revert.
    const plan = planTagsFor("p1", ["Sale"], ["sale"]);
    expect(plan.toAdd).toEqual([]);
    expect(plan.alreadyPresent).toEqual(["Sale"]);
  });

  it("ignores surrounding whitespace", () => {
    expect(planTagsFor("p1", ["  SALE  "], ["SALE"]).toAdd).toEqual([]);
  });

  it("drops empty entries rather than adding a blank tag", () => {
    expect(planTagsFor("p1", ["", "   ", "SALE"], []).toAdd).toEqual(["SALE"]);
  });

  it("counts a tag listed twice in the kit only once", () => {
    // Otherwise the ledger claims ownership of two copies of something that exists
    // once, and the second removal would be removing nothing -- or worse, a merchant's.
    const plan = planTagsFor("p1", ["SALE", "sale"], []);
    expect(plan.toAdd).toEqual(["SALE"]);
  });
});

describe("planTagRemoval", () => {
  it("removes what the ledger says was added", () => {
    expect(planTagRemoval([{ productGid: "p1", addedTags: ["SALE"] }])).toEqual([
      { productGid: "p1", toRemove: ["SALE"] },
    ]);
  });

  it("unions across every run of the campaign", () => {
    // A recurring sale, or one resumed after a failure, adds tags over several runs.
    // Taking only the newest run's row strands the earlier ones on the storefront --
    // the "SALE badge on a full-price product weeks later" this exists to prevent.
    const out = planTagRemoval([
      { productGid: "p1", addedTags: ["SALE"] },
      { productGid: "p1", addedTags: ["SUMMER"] },
      { productGid: "p2", addedTags: ["SALE"] },
    ]);

    expect(out).toHaveLength(2);
    expect(out.find((r) => r.productGid === "p1")?.toRemove.sort()).toEqual(["SALE", "SUMMER"]);
  });

  it("leaves a tag another running campaign still owes", () => {
    // Two overlapping sales both tagging "SALE" is ordinary. Ending one must not
    // strip the badge from the other.
    const out = planTagRemoval(
      [{ productGid: "p1", addedTags: ["SALE", "CLEARANCE"] }],
      new Map([["p1", new Set(["sale"])]]),
    );

    expect(out).toEqual([{ productGid: "p1", toRemove: ["CLEARANCE"] }]);
  });

  it("emits no work for a product whose every tag is still owed", () => {
    const out = planTagRemoval(
      [{ productGid: "p1", addedTags: ["SALE"] }],
      new Map([["p1", new Set(["sale"])]]),
    );
    expect(out).toEqual([]);
  });

  it("returns nothing when the campaign never tagged anything", () => {
    expect(planTagRemoval([])).toEqual([]);
  });
});
