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

  it("reads settings saved before the typed-confirmation thresholds as the PRD's defaults (#818)", () => {
    // Every shop's stored JSON predates the two keys. Missing has to mean 1,000 and 50%,
    // not "off": a threshold that read as null would ask for nothing.
    const stored = { neverBelowCost: true, minPrice: 5, approvalThreshold: 200 };
    expect(parseSettings(stored)).toMatchObject({ confirmAboveVariants: 1_000, confirmAboveChangePercent: 50 });
    expect(parseSettings({ confirmAboveVariants: "", confirmAboveChangePercent: null })).toMatchObject({
      confirmAboveVariants: 1_000,
      confirmAboveChangePercent: 50,
    });
  });

  it("keeps a stored threshold, and pulls one out of range back inside it", () => {
    expect(parseSettings({ confirmAboveVariants: 250, confirmAboveChangePercent: 30 })).toMatchObject({
      confirmAboveVariants: 250,
      confirmAboveChangePercent: 30,
    });
    expect(parseSettings({ confirmAboveVariants: 0, confirmAboveChangePercent: 400 })).toMatchObject({
      confirmAboveVariants: 1,
      confirmAboveChangePercent: 100,
    });
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
