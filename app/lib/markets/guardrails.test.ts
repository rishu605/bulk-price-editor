import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { describeMarketSkips, marketGuardrails } from "./guardrails";

describe("marketGuardrails", () => {
  it("drops a minimum price set in another currency, keeping the rest", () => {
    // $5.00 against a euro price threw CurrencyMismatchError and unpriced every market.
    const store = {
      neverBelowCost: true,
      minMarginPercent: 20,
      minPrice: money(500, "USD"),
      missingCostPolicy: "skip" as const,
    };
    expect(marketGuardrails(store, "EUR")).toEqual({
      neverBelowCost: true,
      minMarginPercent: 20,
      missingCostPolicy: "skip",
    });
  });

  it("keeps a minimum price for a market in the store's own currency", () => {
    const store = { minPrice: money(500, "USD") };
    expect(marketGuardrails(store, "USD")).toEqual(store);
  });

  it("does not change the store's own guardrails object", () => {
    const store = { minPrice: money(500, "USD") };
    marketGuardrails(store, "JPY");
    expect(store.minPrice).toEqual(money(500, "USD"));
  });
});

describe("describeMarketSkips", () => {
  it("names the market, the count and the currency a cost cannot be checked in", () => {
    const rows = [
      { status: "skipped", reason: "missing-cost" as const },
      { status: "skipped", reason: "missing-cost" as const },
      { status: "pending" },
    ];
    expect(describeMarketSkips("Europe", "EUR", rows)).toEqual([
      "Europe: 2 variants left at full price. Costs are recorded in your store's currency " +
        "only, so a cost-based guardrail (never below cost, minimum margin) cannot be " +
        "checked in EUR.",
    ]);
  });

  it("uses the shared reason wording for other skips, most common first", () => {
    const rows = [
      { status: "skipped", reason: "non-positive-price" as const },
      { status: "skipped", reason: "below-floor" as const },
      { status: "skipped", reason: "below-floor" as const },
    ];
    expect(describeMarketSkips("Japan", "JPY", rows)).toEqual([
      "Japan: 2 variants left at full price: they would have priced below a guardrail floor.",
      "Japan: 1 variant left at full price: they would have priced at or below zero.",
    ]);
  });

  it("reads a missing cost literally in the store's own currency", () => {
    // There, costs do reach the market; a skip means the variant really has none.
    const rows = [{ status: "skipped", reason: "missing-cost" as const }];
    expect(describeMarketSkips("United States", "USD", rows, true)).toEqual([
      "United States: 1 variant left at full price: they have no cost recorded, and a " +
        "cost-based guardrail applies.",
    ]);
  });

  it("says nothing when nothing was skipped", () => {
    expect(describeMarketSkips("Europe", "EUR", [{ status: "pending" }])).toEqual([]);
  });
});
