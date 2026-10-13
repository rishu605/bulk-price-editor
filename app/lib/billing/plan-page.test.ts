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
  it("is offered on the plan page, one form per plan", () => {
    expect(page, "1.2.3 requires an in-app way to change plan").toMatch(/<fetcher\.Form method="post"/);
    expect(page).toMatch(/name="plan" value=\{plan\.id\}/);
  });

  it("charges through the Billing API, and cancels for Free (#860)", () => {
    expect(page).toContain("billing.request(");
    expect(page).toContain("billing.cancel(");
  });

  it("never links to App Pricing's hosted picker, which was the 404 App Review found", () => {
    expect(page).not.toMatch(/pricing_plans|pricingPlansUrl|pricingUrl/);
  });

  it("says whether a charge is a test, rather than taking the library's default of yes", () => {
    // `billing.request` defaults `isTest` to true: left out, no merchant would ever pay.
    expect(page).toMatch(/isTest,/);
    expect(page).toContain("isTestCharge(");
  });

  it("offers it on a development store too, so App Review can try the charge flow", () => {
    expect(page).not.toMatch(/exempt \?\s*null\s*:\s*pricing/);
    expect(page).not.toMatch(/\{exempt \? null : <ActionRow/);
  });

  it("reads the plan back from Shopify on load, so the page shows what was just approved", () => {
    expect(page).toContain("syncSubscription(");
  });
});
