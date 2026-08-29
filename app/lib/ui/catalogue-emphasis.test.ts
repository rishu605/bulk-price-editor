/**
 * On the catalogue, weight goes to the rows that moved.
 *
 * The page lists every variant with its live price, its baseline, and a state. Almost all
 * of them are at baseline almost all of the time — that is what a healthy store looks
 * like — and the page was giving each of those rows a green `At baseline` badge. A
 * screenful of success badges is a screenful of colour drawing the eye to variants that
 * need nothing, with the one row that had drifted competing against forty that had not.
 *
 * Colour spent on the normal case is colour that carries no information. So the normal
 * case is quiet now, and the two exceptions keep their tone.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const CATALOGUE = sourceOf("app/routes/app.prices._index.tsx");

describe("the state column", () => {
  it("does not give the normal case a success badge", () => {
    // The specific thing that was wrong, so reinstating it fails here.
    expect(CATALOGUE).not.toContain('<s-badge tone="success">At baseline</s-badge>');
  });

  it("says the normal case quietly, and still says it", () => {
    // Quiet is not absent. WCAG 1.4.1 is about meaning carried by colour alone, and the
    // fix for a screenful of green is not an empty cell — a merchant scanning the column
    // has to be able to tell "checked and fine" from "not checked yet".
    expect(CATALOGUE).toContain('<s-text color="subdued">At baseline</s-text>');
  });

  it("keeps a tone on both exceptions", () => {
    // Drifted, and never captured. These are the two a merchant is looking for, and they
    // are now the only coloured things in the column.
    expect(CATALOGUE).toContain('<s-badge tone="info">Not at baseline</s-badge>');
    expect(CATALOGUE).toContain('<s-badge tone="warning">No baseline</s-badge>');
  });
});

describe("the live price", () => {
  it("is emphasised only when it differs from the baseline", () => {
    // The column the page exists for. Weighting every live price weights none of them.
    expect(CATALOGUE).toMatch(/row\.atBaseline \? \(\s*row\.price\s*\) : \(\s*<s-text type="strong">/);
  });
});

describe("the currency", () => {
  it("is named once, under the table", () => {
    // Four money columns of bare numbers said nothing about which currency they were in.
    // Naming it in each header spends four headings saying one thing.
    expect(CATALOGUE).toContain("Amounts are your store&rsquo;s base price, in {currency}");
  });

  it("comes from the shop rather than from the first row", () => {
    // The row currency is per-variant and a page showing a mixture would label them all
    // with whichever sorted first — the shape of #473.
    expect(CATALOGUE).toContain("currency: await shopCurrency(shop.id)");
  });
});
