/**
 * The one-field card on Home, and the promise it makes before the button.
 *
 * Sami's dashboard has the same idea and it is the best thing in their app. The
 * difference is where it ends: theirs can write prices — Save with "start now" changes
 * every price in a catalogue on one click — and ours makes a draft. That is the safety
 * property this whole product is built on, so the card has to say it *before* the button
 * rather than leave a merchant to discover it.
 *
 * A source check, because what is being defended is what the page promises and what the
 * action does, not how either looks.
 */


import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const HOME = sourceOf("app/routes/app._index.tsx");

const at = (needle: string) => HOME.indexOf(needle);

describe("what the card promises", () => {
  it("says it makes a draft, before the button rather than after", () => {
    const promise = at("Creates a draft");
    const button = at("Create the draft");

    expect(promise).toBeGreaterThan(-1);
    expect(promise, "the promise is below the button that makes it").toBeLessThan(button);
  });

  it("says how many variants it covers, from the real count", () => {
    expect(HOME).toContain("formatCount(health.variants)");
  });

  it("offers the full editor as the alternative rather than hiding it", () => {
    expect(HOME).toContain("/app/campaigns/new");
  });
});

describe("what the action does", () => {
  it("creates a campaign and never runs one", () => {
    const branch = HOME.slice(at('intent === "quick-campaign"'), at('intent === "sync"'));

    expect(branch).toContain("createCampaign(");
    expect(branch, "quick create must not apply anything").not.toContain("runCampaign");
  });

  it("targets every variant, which is what the card says", () => {
    const branch = HOME.slice(at('intent === "quick-campaign"'), at('intent === "sync"'));

    expect(branch).toContain("ast: { groups: [] }");
  });

  it("negates the percentage, because the field asks for a discount", () => {
    // The field is labelled "% off" and takes a positive number; the rule takes a signed
    // one. Losing the minus sign here raises every price in the shop.
    const branch = HOME.slice(at('intent === "quick-campaign"'), at('intent === "sync"'));

    expect(branch).toContain("percent: -parsed.percent");
  });

  it("takes rounding from the shop rather than inventing one", () => {
    const branch = HOME.slice(at('intent === "quick-campaign"'), at('intent === "sync"'));

    expect(branch).toContain("rounding: settings.rounding");
  });

  it("refuses before creating anything when the number is wrong", () => {
    const branch = HOME.slice(at('intent === "quick-campaign"'), at('intent === "sync"'));

    expect(branch.indexOf("if (!parsed.ok)")).toBeLessThan(branch.indexOf("createCampaign("));
  });
});
