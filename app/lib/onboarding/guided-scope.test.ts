/**
 * Whether guided mode keeps the promise its own banner makes.
 *
 * The third checklist step is "Run your first real campaign", its teaching reads "Start
 * small — five products is plenty", and its button opens `/app/campaigns/new?guided=1`.
 * That page said the same thing — "narrow the scope to a handful of products" — and
 * defaulted the scope to **everything**: on `dartmode-labs` the preview opened on "3,669
 * of 3,669 variants would change price".
 *
 * So a first-time merchant pressing the obvious button got a whole-catalogue sale,
 * having just been told they were doing a small one. `GUIDED_PRODUCT_LIMIT` had been
 * sitting in `steps.ts` since the flow was written and nothing read it.
 *
 * Checked against the source, because the gate is a loader field and a `disabled`
 * attribute, and this route cannot be rendered here without a data router.
 */

import { describe, expect, it } from "vitest";

import { GUIDED_PRODUCT_LIMIT } from "./steps";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
const STEPS = sourceOf("app/lib/onboarding/steps.ts");

describe("the promise", () => {
  it("is made with the constant rather than a number typed twice", () => {
    // The banner said "five is plenty" in prose while the constant said 5 in code, so
    // changing one would have left the other saying something else.
    expect(EDITOR).toContain("{GUIDED_PRODUCT_LIMIT} is plenty");
  });

  it("is still the number the checklist teaches", () => {
    expect(GUIDED_PRODUCT_LIMIT).toBe(5);
    expect(STEPS).toContain("five products is plenty");
  });
});

describe("the gate", () => {
  it("knows when a guided campaign still covers everything", () => {
    expect(EDITOR).toContain("guidedNeedsScope");
    // Every scope field, from the shared list — a gate that checked three of five would
    // pass a campaign narrowed by neither of the other two.
    expect(EDITOR).toMatch(
      /guided && !segmentId && SCOPE_CONDITION_FIELDS\.every\(\(field\) => !url\.searchParams\.get\(field\)\)/,
    );
  });

  it("counts a saved segment as a scope", () => {
    // A segment replaces the inline filter rather than narrowing it, so a campaign with
    // one is already narrowed and must not be held up.
    expect(EDITOR).toContain("!segmentId &&");
  });

  it("stops the submit rather than refusing after it", () => {
    // Telling a merchant their first campaign was too big, after they pressed the
    // button, is telling them too late.
    expect(EDITOR).toContain("disabled={guidedNeedsScope || undefined}");
  });

  it("says what to do, not merely that something is missing", () => {
    expect(EDITOR).toContain("Pick a collection, a vendor, a tag or a title");
  });
});

describe("what the gate must not do", () => {
  it("leaves an ordinary campaign alone", () => {
    // Only guided mode promises small. The full editor is for merchants who know what
    // they are doing, and a whole-catalogue sale is a legitimate thing to want.
    expect(EDITOR).toMatch(/guidedNeedsScope:\s*\n?\s*guided &&/);
  });

  it("leaves practice mode alone", () => {
    // Practice writes nothing, so scope size costs nothing but time.
    expect(EDITOR).not.toContain("practice && guidedNeedsScope");
  });
});
