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

import { astFrom, compareAtFrom, readerFor, ruleFrom } from "./draft-form";

const read = (fields: Record<string, string>) => readerFor(new URLSearchParams(fields));

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
