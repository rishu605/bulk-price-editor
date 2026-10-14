/**
 * Refusing a guardrail the merchant could not have meant (#739), and an approval
 * threshold that is not a count (#788).
 */

import { describe, expect, it } from "vitest";

import {
  APPROVAL_THRESHOLD_LABEL,
  approvalThresholdFrom,
  CONFIRM_CHANGE_LABEL,
  CONFIRM_VARIANTS_LABEL,
  confirmPercentFrom,
  confirmVariantsFrom,
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

describe("checking the typed-confirmation thresholds (#818)", () => {
  it.each(["0", "-3", "abc", "1.5", "1e3", "+5"])("refuses %s variants, naming the field and the default", (typed) => {
    const [problem, ...rest] = problems({ confirmAboveVariants: typed });
    expect(rest).toEqual([]);
    expect(problem.field).toBe("confirmAboveVariants");
    expect(problem.message).toBe(
      `${CONFIRM_VARIANTS_LABEL} must be a whole number of 1 or more, such as the default 1,000. “${typed}” is not.`,
    );
  });

  it.each(["0", "101", "150", "-50", "12.5", "abc"])("refuses a change of %s", (typed) => {
    const [problem, ...rest] = problems({ confirmAboveChangePercent: typed });
    expect(rest).toEqual([]);
    expect(problem.field).toBe("confirmAboveChangePercent");
    expect(problem.message).toBe(
      `${CONFIRM_CHANGE_LABEL} must be a whole number from 1 to 100, such as the default 50. “${typed}” is not.`,
    );
  });

  it("refuses a blank one, since neither can be switched off, and says it is empty", () => {
    expect(problems({ confirmAboveVariants: "  " })[0].message).toMatch(/It is empty\.$/);
    expect(problems({ confirmAboveChangePercent: "" })[0].message).toMatch(/It is empty\.$/);
  });

  it("asks nothing of a form that does not carry them: missing keeps the stored value", () => {
    expect(problems({})).toEqual([]);
  });

  it("accepts the edges", () => {
    expect(problems({ confirmAboveVariants: "1", confirmAboveChangePercent: "1" })).toEqual([]);
    expect(problems({ confirmAboveVariants: " 250000 ", confirmAboveChangePercent: "100" })).toEqual([]);
  });

  it("reports them with the other bad fields", () => {
    expect(
      problems({ approvalThreshold: "0", confirmAboveVariants: "0", confirmAboveChangePercent: "0" }).map((p) => p.field),
    ).toEqual(["approvalThreshold", "confirmAboveVariants", "confirmAboveChangePercent"]);
  });
});

describe("reading the typed-confirmation thresholds", () => {
  it("is the number for one that can be saved", () => {
    expect(confirmVariantsFrom(" 250 ")).toBe(250);
    expect(confirmVariantsFrom("1")).toBe(1);
    expect(confirmPercentFrom("1")).toBe(1);
    expect(confirmPercentFrom("100")).toBe(100);
  });

  it("is undefined for blank, absent or anything else, never a default nobody typed", () => {
    for (const typed of [null, "", "0", "abc", "1.5"]) {
      expect(confirmVariantsFrom(typed), String(typed)).toBeUndefined();
      expect(confirmPercentFrom(typed), String(typed)).toBeUndefined();
    }
    expect(confirmPercentFrom("101")).toBeUndefined();
  });
});
