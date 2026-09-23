/**
 * The plan page has to be able to change the plan.
 *
 * App Store requirement 1.2.3, *Allow pricing plan changes*: "your app must allow
 * merchants to upgrade and downgrade their pricing plan without having to contact your
 * support team or having to reinstall the app."
 *
 * For a long time it could not. The page rendered three cards — the plan table, what is
 * free on every plan, what a downgrade does — and not one link. Every in-app prompt that
 * leads there, including Home's "See plans" when a catalogue outgrows its plan, arrived at
 * a table saying Growth would cover them and no way to say yes.
 *
 * The regression is silent: the page still renders, still reads correctly, and the missing
 * thing is a button nobody notices the absence of until a merchant tries to pay. So it is
 * asserted on the source, where deleting it is visible.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const page = sourceOf("app/routes/app.settings.plan.tsx");

describe("changing plan", () => {
  it("is offered on the plan page", () => {
    expect(page, "1.2.3 requires an in-app way to change plan").toMatch(
      /<s-button[^>]*href=\{pricingUrl\}/,
    );
  });

  it("goes to Shopify's own picker, which is the only thing that can take the money", () => {
    expect(page).toContain("pricingPlansUrl(");
  });

  it("reads the handle rather than carrying a copy of it", () => {
    // A handle in an env var is wrong after a rename, and the symptom is a 404 on the one
    // page where somebody decided to pay.
    expect(page).toContain("appHandle(");
    expect(page).not.toMatch(/APP_HANDLE|process\.env/);
  });

  it("shows nothing on a development store, where nothing is charged", () => {
    expect(page).toMatch(/billing\.exempt \?\s*null/);
  });
});
