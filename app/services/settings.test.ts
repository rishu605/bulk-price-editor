import { describe, expect, it } from "vitest";

import { parseSettings, toGuardrails, DEFAULT_SETTINGS } from "./settings.server";

describe("parseSettings", () => {
  it("defaults everything when the stored value is empty or junk", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("treats blank fields as 'no floor', not as zero", () => {
    // Zero is a real floor; blank means the merchant did not set one. Conflating
    // them would silently apply a floor nobody asked for.
    const parsed = parseSettings({ minPrice: "", minMarginPercent: "" });
    expect(parsed.minPrice).toBeNull();
    expect(parsed.minMarginPercent).toBeNull();
  });

  it("clamps rather than rejecting an out-of-range margin", () => {
    // Refusing the whole save would lose the merchant's other edits.
    expect(parseSettings({ minMarginPercent: 150 }).minMarginPercent).toBe(99.9);
    expect(parseSettings({ minMarginPercent: -20 }).minMarginPercent).toBe(0);
  });

  it("falls back to a safe policy for unrecognised values", () => {
    expect(parseSettings({ violationPolicy: "nonsense" }).violationPolicy).toBe("clamp");
    expect(parseSettings({ missingCostPolicy: "nonsense" }).missingCostPolicy).toBe("skip");
  });

  it("only treats an explicit true as enabling never-below-cost", () => {
    expect(parseSettings({ neverBelowCost: "yes" }).neverBelowCost).toBe(false);
    expect(parseSettings({ neverBelowCost: true }).neverBelowCost).toBe(true);
  });
});

describe("toGuardrails", () => {
  it("converts a minimum price using the currency's own precision", () => {
    // A hardcoded x100 would read a 1000 yen floor as 100,000 yen.
    const settings = { ...DEFAULT_SETTINGS, minPrice: 10 };
    expect(toGuardrails(settings, "USD").minPrice).toEqual({ amount: 1000, currency: "USD" });
    expect(toGuardrails(settings, "JPY").minPrice).toEqual({ amount: 10, currency: "JPY" });
    expect(toGuardrails(settings, "KWD").minPrice).toEqual({ amount: 10000, currency: "KWD" });
  });

  it("omits floors the merchant did not set", () => {
    const guardrails = toGuardrails(DEFAULT_SETTINGS, "USD");
    expect(guardrails.minPrice).toBeUndefined();
    expect(guardrails.minMarginPercent).toBeUndefined();
  });

  it("carries the policies through to the resolver", () => {
    const guardrails = toGuardrails(
      { ...DEFAULT_SETTINGS, neverBelowCost: true, missingCostPolicy: "error" },
      "USD",
    );
    expect(guardrails.neverBelowCost).toBe(true);
    expect(guardrails.missingCostPolicy).toBe("error");
  });
});
