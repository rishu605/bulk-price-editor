/**
 * Refusing a guardrail the merchant could not have meant (#739).
 */

import { describe, expect, it } from "vitest";

import { guardrailInputProblems, MAX_MARGIN_PERCENT } from "./guardrail-input";

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;
const problems = (fields: Record<string, string>) => guardrailInputProblems(form(fields), "USD");

describe("checking typed guardrails", () => {
  it("refuses a 150% margin rather than saving 99.9, and says what is allowed", () => {
    const [problem, ...rest] = problems({ minMarginPercent: "150" });
    expect(rest).toEqual([]);
    expect(problem.field).toBe("minMarginPercent");
    expect(problem.message).toBe(
      `Minimum margin (%) must be a number from 0 to ${MAX_MARGIN_PERCENT}, or blank for none. “150” is not.`,
    );
  });

  it("refuses a negative minimum price rather than saving 0", () => {
    const [problem] = problems({ minPrice: "-5" });
    expect(problem.field).toBe("minPrice");
    expect(problem.message).toMatch(/Minimum price \(USD\) must be zero or more/);
  });

  it("refuses a word, which used to switch the guardrail off", () => {
    expect(problems({ minMarginPercent: "twenty" }).map((p) => p.field)).toEqual(["minMarginPercent"]);
    expect(problems({ minPrice: "abc" }).map((p) => p.field)).toEqual(["minPrice"]);
  });

  it("reports every bad field at once, so one save fixes them all", () => {
    expect(problems({ minMarginPercent: "150", minPrice: "-5" })).toHaveLength(2);
  });

  it("accepts blank as none, and every value in range", () => {
    expect(problems({ minMarginPercent: "", minPrice: "" })).toEqual([]);
    expect(problems({ minMarginPercent: "  " })).toEqual([]);
    expect(problems({ minMarginPercent: "0", minPrice: "0" })).toEqual([]);
    expect(problems({ minMarginPercent: "25", minPrice: "4.99" })).toEqual([]);
    expect(problems({ minMarginPercent: String(MAX_MARGIN_PERCENT) })).toEqual([]);
  });

  it("refuses just past the edge", () => {
    expect(problems({ minMarginPercent: "100" })).toHaveLength(1);
    expect(problems({ minMarginPercent: "-0.1" })).toHaveLength(1);
  });
});
