/**
 * One parser for the preview and for the submit.
 *
 * The pair of bugs this pins (#343): the editor's form has no currency field, so
 * `form.get("currency") ?? "USD"` made every fixed-amount rule USD on every store; and
 * the conversion to minor units used a literal 100, which is right for dollars and
 * wrong for every zero-decimal currency. Together, ¥3,000 became 300,000 minor units
 * labelled USD.
 *
 * Both are only reachable through `fixed-change` and `set-exact`. `percent-change` is
 * the default and carries a plain number, which is why two USD dev stores never showed
 * either.
 */

import { describe, expect, it } from "vitest";

import {
  astFrom,
  compareAtFrom,
  readerFor,
  ruleFrom,
  ruleInputProblem,
  DEFAULT_PRIORITY,
  DEFAULT_REVERT_BUFFER_MINUTES,
  priorityFrom,
  revertBufferFrom,
} from "./draft-form";

const read = (fields: Record<string, string>) => readerFor(new URLSearchParams(fields));

describe("a rule amount the merchant has not given (#696)", () => {
  it("refuses a blank amount, naming the field, for every kind of rule", () => {
    expect(ruleInputProblem(read({ ruleKind: "set-exact", ruleValue: "" }), "USD")).toBe("The exact price is empty. Enter a number.");
    expect(ruleInputProblem(read({ ruleKind: "fixed-change", ruleValue: "  " }), "USD")).toBe("The amount to change by is empty. Enter a number.");
    expect(ruleInputProblem(read({ ruleKind: "percent-change" }), "USD")).toBe("The percentage is empty. Enter a number.");
  });

  it("refuses a decimal comma, and says how to write it", () => {
    expect(ruleInputProblem(read({ ruleKind: "set-exact", ruleValue: "1,5" }), "USD")).toBe(
      'The exact price "1,5" is not a number. Use a full stop for decimals, as in 1.5.',
    );
    expect(ruleInputProblem(read({ ruleKind: "percent-change", ruleValue: "abc" }), "USD")).toBe('The percentage "abc" is not a number.');
  });

  it("refuses an exact price of zero or less, rather than letting it be clamped to 0.01", () => {
    for (const ruleValue of ["0", "-5"]) {
      expect(ruleInputProblem(read({ ruleKind: "set-exact", ruleValue }), "USD"), ruleValue).toMatch(/^An exact price has to be more than zero/);
    }
  });

  it("refuses a reduction of 100% or more, in either spelling", () => {
    expect(ruleInputProblem(read({ ruleKind: "percent-change", ruleValue: "150", ruleDirection: "down" }), "USD")).toBe(
      "A 150% reduction would make every price free or negative. Enter less than 100.",
    );
    expect(ruleInputProblem(read({ ruleKind: "percent-change", ruleValue: "-100" }), "USD")).toMatch(/^A 100% reduction/);
  });

  it("refuses a change of zero, which would leave every price where it is", () => {
    expect(ruleInputProblem(read({ ruleKind: "percent-change", ruleValue: "0", ruleDirection: "down" }), "USD")).toMatch(/is 0, which would leave/);
  });

  it("accepts what a merchant means", () => {
    const meant: Array<Record<string, string>> = [
      { ruleKind: "set-exact", ruleValue: "9.99" },
      { ruleKind: "fixed-change", ruleValue: "5", ruleDirection: "down" },
      { ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down" },
      { ruleKind: "percent-change", ruleValue: "150", ruleDirection: "up" },
      { ruleKind: "percent-change", ruleValue: "-20" },
    ];
    for (const fields of meant) {
      expect(ruleInputProblem(read(fields), "USD"), JSON.stringify(fields)).toBeNull();
    }
  });
});

describe("an amount with more decimals than its currency has (#1068)", () => {
  // `Math.round(9.995 * 100)` is `Math.round(999.4999999999999)`: the double nearest 9.995
  // sits just under it, so 9.995 saved 9.99 while 4.355 saved 4.36. The same half cent went
  // either way by float error, and no field said the third decimal was not a price.
  it.each([
    ["set-exact", "9.995", "USD", "The exact price 9.995 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 9.99 or 10.00."],
    ["set-exact", "1.005", "USD", "The exact price 1.005 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 1.00 or 1.01."],
    ["fixed-change", "4.355", "USD", "The amount to change by 4.355 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 4.35 or 4.36."],
    ["fixed-change", "0.145", "USD", "The amount to change by 0.145 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 0.14 or 0.15."],
    ["set-exact", "1500.5", "JPY", "The exact price 1500.5 has 1 decimal place, but JPY has none. Enter a whole number, such as 1500 or 1501."],
    ["set-exact", "1.0005", "KWD", "The exact price 1.0005 has 4 decimal places, but KWD has 3. Enter it to 3 decimal places, such as 1.000 or 1.001."],
  ])("refuses %s %s in %s, naming the field, the value and the currency's decimals", (ruleKind, ruleValue, currency, message) => {
    expect(ruleInputProblem(read({ ruleKind, ruleValue }), currency)).toBe(message);
    expect(ruleInputProblem(read({ ruleKind, ruleValue, ruleDirection: "down" }), currency)).toBe(message);
  });

  it("refuses rather than rounds in ruleFrom too, for a caller that did not ask first", () => {
    expect(() => ruleFrom(read({ ruleKind: "set-exact", ruleValue: "9.995" }), "USD")).toThrow(
      "The exact price 9.995 has 3 decimal places, but USD has 2.",
    );
    expect(() => ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "1500.5", ruleDirection: "down" }), "JPY")).toThrow(
      /1500\.5 has 1 decimal place, but JPY has none/,
    );
  });

  it("refuses an exact price that is not a plain amount, rather than reading 1e3 as a thousand", () => {
    expect(ruleInputProblem(read({ ruleKind: "set-exact", ruleValue: "1e3" }), "USD")).toBe(
      "The exact price 1e3 is not a plain amount. Enter digits with a full stop for decimals, such as 12.50.",
    );
  });

  it.each([
    ["set-exact", "9.99", "USD", 999],
    ["set-exact", "9.9900", "USD", 999],
    ["set-exact", "0.29", "USD", 29],
    ["set-exact", "1500", "JPY", 1500],
    ["set-exact", "1.005", "KWD", 1005],
    ["fixed-change", "-4.35", "USD", -435],
    ["fixed-change", "1500", "JPY", 1500],
  ])("stores %s %s %s as exactly the minor units typed", (ruleKind, ruleValue, currency, minor) => {
    expect(ruleInputProblem(read({ ruleKind, ruleValue }), currency)).toBeNull();
    expect(ruleFrom(read({ ruleKind, ruleValue }), currency)).toEqual({ kind: ruleKind, amount: { amount: minor, currency } });
  });

  it("keeps the direction on an exact fixed amount", () => {
    expect(ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "1.005", ruleDirection: "down" }), "KWD")).toEqual({
      kind: "fixed-change",
      amount: { amount: -1005, currency: "KWD" },
    });
    expect(ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "-0.29", ruleDirection: "up" }), "USD")).toEqual({
      kind: "fixed-change",
      amount: { amount: 29, currency: "USD" },
    });
  });

  it("leaves a percentage's decimals alone: it is not money, and the maths reads it exactly", () => {
    expect(ruleInputProblem(read({ ruleKind: "percent-change", ruleValue: "12.345", ruleDirection: "down" }), "JPY")).toBeNull();
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "12.345", ruleDirection: "down" }), "JPY")).toEqual({
      kind: "percent-change",
      percent: -12.345,
    });
  });
});

describe("money in the rule", () => {
  it("uses the currency it is given, not a default", () => {
    const rule = ruleFrom(read({ ruleKind: "set-exact", ruleValue: "3000" }), "JPY");

    expect(rule).toEqual({ kind: "set-exact", amount: { amount: 3000, currency: "JPY" } });
  });

  it("does not multiply a zero-decimal currency by a hundred", () => {
    const rule = ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "-500" }), "JPY");

    expect(
      rule,
      "¥500 is 500 minor units; a hardcoded 100 would make it ¥50,000",
    ).toEqual({ kind: "fixed-change", amount: { amount: -500, currency: "JPY" } });
  });

  it("still handles two-decimal currencies", () => {
    const rule = ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "-10.50" }), "USD");

    expect(rule).toEqual({ kind: "fixed-change", amount: { amount: -1050, currency: "USD" } });
  });

  it("handles a three-decimal currency", () => {
    const rule = ruleFrom(read({ ruleKind: "set-exact", ruleValue: "1.5" }), "KWD");

    expect(rule, "1.5 KWD is 1500 fils").toEqual({
      kind: "set-exact",
      amount: { amount: 1500, currency: "KWD" },
    });
  });

  it("keeps a percentage a plain number, with no currency involved", () => {
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20" }), "JPY")).toEqual({
      kind: "percent-change",
      percent: -20,
    });
  });

  it("defaults to a percentage, which is what the editor offers first", () => {
    expect(ruleFrom(read({ ruleValue: "-15" }), "USD")).toEqual({
      kind: "percent-change",
      percent: -15,
    });
  });
});

describe("compare-at", () => {
  it.each([
    ["set-to-baseline", { kind: "set-to-baseline" }],
    ["clear", { kind: "clear" }],
    ["leave", { kind: "leave" }],
  ])("reads %s", (value, expected) => {
    expect(compareAtFrom(read({ compareAt: value }))).toEqual(expected);
  });

  it("leaves it alone when nothing was chosen", () => {
    expect(compareAtFrom(read({}))).toEqual({ kind: "leave" });
  });
});

describe("scope", () => {
  it("builds one group from the fields that were filled in", () => {
    // Order follows SCOPE_CONDITION_FIELDS, not the order they were typed, so the same
    // filter produces the same AST however the merchant filled the form in.
    expect(astFrom(read({ vendor: "Acme", tag: "sale" }))).toEqual({
      groups: [
        {
          conditions: [
            { field: "tag", value: "sale" },
            { field: "vendor", value: "Acme" },
          ],
        },
      ],
    });
  });

  it("means every variant when nothing is filled in, not none", () => {
    expect(astFrom(read({}))).toEqual({ groups: [] });
  });

  it("ignores whitespace someone typed and deleted", () => {
    expect(astFrom(read({ tag: "   " }))).toEqual({ groups: [] });
  });

  it("trims, so a trailing space does not make a tag not match", () => {
    expect(astFrom(read({ tag: " sale " }))).toEqual({
      groups: [{ conditions: [{ field: "tag", value: "sale" }] }],
    });
  });
});

describe("the same parser reads a form and a query string", () => {
  it("agrees between the two, because the preview posts and the submit posts", () => {
    const form = new FormData();
    form.set("ruleKind", "fixed-change");
    form.set("ruleValue", "-7.25");

    expect(ruleFrom(readerFor(form), "USD")).toEqual(
      ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "-7.25" }), "USD"),
    );
  });
});

describe("priority and revert buffer (#727)", () => {
  const read = (fields: Record<string, string>) => readerFor(new URLSearchParams(fields));

  it("keeps 0, which is a value and not a blank", () => {
    expect(priorityFrom(read({ priority: "0" }))).toBe(0);
    expect(revertBufferFrom(read({ revertBuffer: "0" }))).toBe(0);
  });

  it("takes the default only when the field is missing, blank or not a number", () => {
    const blanks: Array<Record<string, string>> = [{}, { priority: "" }, { priority: "  " }, { priority: "high" }];
    for (const fields of blanks) {
      expect(priorityFrom(read(fields))).toBe(DEFAULT_PRIORITY);
    }
    expect(revertBufferFrom(read({ revertBuffer: "soon" }))).toBe(DEFAULT_REVERT_BUFFER_MINUTES);
  });

  it("stores whole numbers, and no negative buffer", () => {
    expect(priorityFrom(read({ priority: "40.7" }))).toBe(40);
    expect(priorityFrom(read({ priority: "-5" }))).toBe(-5);
    expect(revertBufferFrom(read({ revertBuffer: "-3" }))).toBe(0);
  });
});
