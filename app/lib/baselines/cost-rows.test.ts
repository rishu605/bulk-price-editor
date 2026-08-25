/**
 * Validating imported costs.
 *
 * A cost is not a price: importing one changes nothing on the storefront, it changes
 * what the app will refuse to do. That makes the failure mode different — a wrong cost
 * is a wrong floor, not a wrong price — and this validates accordingly.
 */

import { describe, expect, it } from "vitest";

import { isValidCost, validateCostRow } from "./cost-rows";

const row = (over: Record<string, string> = {}) => ({
  line: 2,
  identifier: "SKU-1",
  price: "",
  cost: "12.50",
  ...over,
});

describe("reading a cost from a row", () => {
  it("parses a plain number in the shop's currency", () => {
    const result = validateCostRow(row(), "USD");

    expect(isValidCost(result)).toBe(true);
    if (isValidCost(result)) expect(result.parsedCost.amount).toBe(1250);
  });

  it("uses the row's own currency when it names one", () => {
    // Precision is currency-specific. "1250" is ¥1,250 and $12.50, and taking the
    // shop's currency for a row that named another is off by a factor of a hundred.
    const result = validateCostRow(row({ cost: "1250", currency: "JPY" }), "USD");

    expect(isValidCost(result) && result.parsedCost.amount).toBe(1250);
  });

  it("accepts a cost of zero", () => {
    // Unlike a zero baseline, which makes every percentage campaign compute to zero.
    // A sample or a giveaway genuinely costs nothing, and refusing it would force the
    // merchant to drop the row and lose the fact that the cost is known.
    const result = validateCostRow(row({ cost: "0" }), "USD");

    expect(isValidCost(result)).toBe(true);
  });

  it("refuses a negative cost", () => {
    expect(isValidCost(validateCostRow(row({ cost: "-1" }), "USD"))).toBe(false);
  });

  it("refuses a cost with a currency symbol, and says how to fix it", () => {
    const result = validateCostRow(row({ cost: "$12.50" }), "USD");

    expect(isValidCost(result)).toBe(false);
    if (!isValidCost(result)) expect(result.reason).toContain("12.50, not $12.50");
  });

  it("refuses a row with no identifier to match on", () => {
    expect(isValidCost(validateCostRow(row({ identifier: "" }), "USD"))).toBe(false);
  });

  it("treats a blank cost as a row to leave out, not a zero", () => {
    // Reading blank as zero would set a floor of nothing on every product whose cost
    // the merchant simply had not filled in — turning the guardrail off silently.
    const result = validateCostRow(row({ cost: "" }), "USD");

    expect(isValidCost(result)).toBe(false);
    if (!isValidCost(result)) expect(result.problem).toBe("no-cost");
  });

  it("refuses a fractional minor unit in a zero-decimal currency", () => {
    // ¥12.50 is not a cost that exists.
    expect(isValidCost(validateCostRow(row({ cost: "12.50", currency: "JPY" }), "USD")))
      .toBe(false);
  });
});
