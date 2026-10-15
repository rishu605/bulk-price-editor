/**
 * Counts in route copy go through the shared plural helper (#759).
 *
 * Asserted on the source, because these sentences sit in route components and loaders
 * that need a session to render. The helpers themselves are tested in `display.test.ts`;
 * what is pinned here is that these routes use them rather than a noun written after a
 * bare number, which is how What's live came to say "1 rows." under its own table.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

describe("route sentences that count", () => {
  it("What's live counts its rows in the singular for one", () => {
    const live = sourceOf("app/routes/app.prices.live.tsx");

    expect(live).toContain('{countOf(total, "row")}.');
    expect(live).not.toMatch(/\{formatCount\(total\)\} rows\./);
  });

  it("the spreadsheet campaign's check groups its counts", () => {
    const prices = sourceOf("app/routes/app.price-import.tsx");

    expect(prices).toContain('${formatCount(result.ready)} of ${countOf(result.total, "row")} matched a product');
  });
});
