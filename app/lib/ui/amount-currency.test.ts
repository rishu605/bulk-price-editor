/**
 * The amount a merchant types is labelled in the currency it is built in.
 *
 * The editor keeps a sorted list of every currency a campaign could price in, because the
 * per-currency rounding selects need all of them. It used to hand the **first** of that
 * list to the field the amount is typed into:
 *
 *     <RuleValueField currency={currencies[0] ?? "USD"} />
 *
 * That is alphabetical order, not the shop. On a USD shop with CAD, EUR and JPY price
 * lists the field read "Amount (CAD)" while `ruleFrom` built the amount in USD, and #444's
 * storefront card inherited it and announced "base price · CAD".
 *
 * `s-money-field` exists precisely because it knows how many decimals an amount has, so
 * this is not only a label: a shop whose first-sorted list is JPY gets a zero-decimal
 * entry field for a two-decimal rule. Same family as #343 — the form has no currency
 * field, so a currency gets chosen by something that is not the shop.
 */


import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");

describe("nothing labels an amount from the sorted list", () => {
  it("passes the shop's own currency to the amount field", () => {
    // Across lines: the component took two more props when a spreadsheet became one of
    // the ways prices change, so it is no longer written on one.
    expect(EDITOR).toMatch(/<RuleValueField[\s\S]{0,120}currency=\{baseCurrency\}/);
  });

  it("never indexes the sorted currency list", () => {
    // Sorted for the rounding selects, which want all of them. The first entry means
    // nothing, and reading it is how this bug is written again.
    expect(
      EDITOR,
      "currencies[0] is whichever code sorts first, not the one the rule is built in",
    ).not.toContain("currencies[0]");
  });

  it("takes the base currency from the same place the rule does", () => {
    // `ruleFrom(read, currency)` in the action, `shopCurrency` in the resource route.
    // The loader hands the client that same value rather than deriving a second one.
    expect(EDITOR).toContain("baseCurrency: currency,");
  });

  it("still builds the full list, because the rounding selects need it", () => {
    expect(EDITOR).toContain("const currencies = [");
    expect(EDITOR).toMatch(/currencies\.map/);
  });
});
