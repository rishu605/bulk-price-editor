/**
 * Refusing a guardrail the merchant could not have meant (#739), and an approval
 * threshold that is not a count (#788).
 */

import { describe, expect, it } from "vitest";

import {
  APPROVAL_THRESHOLD_LABEL,
  approvalThresholdFrom,
  guardrailInputProblems,
  MAX_MARGIN_PERCENT,
} from "./guardrail-input";

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

describe("checking a typed approval threshold (#788)", () => {
  it.each(["0", "-3", "abc", "1.5"])("refuses %s, naming the field and what it accepts", (typed) => {
    const [problem, ...rest] = problems({ approvalThreshold: typed });
    expect(rest).toEqual([]);
    expect(problem.field).toBe("approvalThreshold");
    expect(problem.message).toBe(
      `Require a second person's approval above (variants) must be a whole number of 1 or more, or blank for off. “${typed}” is not.`,
    );
  });

  it("names the field by the label the page shows", () => {
    expect(problems({ approvalThreshold: "0" })[0].message.startsWith(APPROVAL_THRESHOLD_LABEL)).toBe(true);
  });

  it("accepts blank as off, and any whole number of 1 or more", () => {
    expect(problems({ approvalThreshold: "" })).toEqual([]);
    expect(problems({ approvalThreshold: "  " })).toEqual([]);
    expect(problems({ approvalThreshold: "1" })).toEqual([]);
    expect(problems({ approvalThreshold: " 500 " })).toEqual([]);
  });

  it("refuses what Number would have let through", () => {
    // `Number` reads every one of these as a whole number, and none of them is one typed.
    for (const typed of ["1e3", "0x10", "+5", "99999999999999999999"]) {
      expect(problems({ approvalThreshold: typed }).map((p) => p.field), typed).toEqual(["approvalThreshold"]);
    }
  });

  it("reports it with the other bad fields, so one save fixes them all", () => {
    expect(problems({ minMarginPercent: "150", approvalThreshold: "0" }).map((p) => p.field)).toEqual([
      "minMarginPercent",
      "approvalThreshold",
    ]);
  });
});

describe("reading a typed approval threshold", () => {
  it("is null for blank or absent; the action tells those two apart", () => {
    expect(approvalThresholdFrom("")).toBeNull();
    expect(approvalThresholdFrom("   ")).toBeNull();
    expect(approvalThresholdFrom(null)).toBeNull();
  });

  it("is the count for a whole number of 1 or more", () => {
    expect(approvalThresholdFrom("1")).toBe(1);
    expect(approvalThresholdFrom(" 500 ")).toBe(500);
    expect(approvalThresholdFrom("007")).toBe(7);
  });

  it("is undefined for anything else, never a number the merchant did not type", () => {
    for (const typed of ["0", "-3", "abc", "1.5", "1e3"]) {
      expect(approvalThresholdFrom(typed), typed).toBeUndefined();
    }
  });
});
