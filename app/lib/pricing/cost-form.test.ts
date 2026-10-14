/**
 * Reading the bulk cost form, and deciding whether a commit follows a check of it (#754).
 *
 * The form opened at 4% and its second button committed on one click: 2,699 costs on a
 * real store, by a number nobody typed. What stands between that and a merchant now is
 * here — an empty amount refused rather than read as zero, and a commit refused unless it
 * carries the key of a check of the very values it posts.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import {
  changedMessage,
  checkedMessage,
  checkKeyOf,
  costCount,
  costScopeOf,
  countMovedMessage,
  readCommit,
  readCostForm,
} from "./cost-form";

const fields = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
};

/** The key a form would be checked under, for forms that read. */
const keyOf = (values: Record<string, string>, currency = "USD") => {
  const read = readCostForm(fields(values), currency);
  if (!read.ok) throw new Error(`expected ${JSON.stringify(values)} to read`);
  return read.key;
};

describe("reading the amount", () => {
  it.each([
    ["missing", {}],
    ["empty", { value: "" }],
    ["only spaces", { value: "   " }],
  ])("refuses an amount that is %s, rather than reading it as zero", (_name, values) => {
    // `Number("")` is 0, and zero under "Set an exact cost" is every cost in the store
    // set to nothing — a floor of zero under every product.
    const read = readCostForm(fields({ ruleKind: "set-exact", ...values }), "USD");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.field).toBe("value");
    expect(read.message).toMatch(/amount is empty/);
    expect(read.message).toMatch(/nothing was checked or changed/);
    // The next action, in the shop's currency (RFC §11: object, cause, next action).
    expect(read.message).toMatch(/an amount in USD, then check it/);
  });

  it("refuses an amount that is not a number", () => {
    const read = readCostForm(fields({ value: "four" }), "GBP");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toMatch(/“four” is not a number/);
  });

  it("reads a typed amount into the rule it describes, in minor units", () => {
    const read = readCostForm(fields({ ruleKind: "set-exact", value: "12.5", vendor: " Acme " }), "USD");

    expect(read).toMatchObject({
      ok: true,
      vendor: "Acme",
      rule: { kind: "set-exact", amount: money(1_250, "USD") },
    });
  });

  it("reads a negative percentage as a cut, which is a real request", () => {
    expect(readCostForm(fields({ value: "-10" }), "USD")).toMatchObject({
      ok: true,
      rule: { kind: "percent-change", percent: -10 },
    });
  });
});

describe("the key a check is made under", () => {
  it("is the same for the same rule however it was typed", () => {
    expect(keyOf({ value: "4" })).toBe(keyOf({ value: "4.0" }));
    expect(keyOf({ value: "4" })).toBe(keyOf({ value: " 4 " }));
  });

  it.each([
    ["the amount", { value: "5" }],
    ["the rule", { ruleKind: "share-of-price", value: "4" }],
    ["the scope", { vendor: "Acme", value: "4" }],
  ])("differs when %s differs", (_name, other) => {
    expect(keyOf({ ruleKind: "percent-change", value: "4" })).not.toBe(
      keyOf({ ruleKind: "percent-change", ...other }),
    );
  });

  it("is of what will be stored, so one typed amount in two currencies is two checks", () => {
    // ¥4 and $4 are 4 and 400 minor units. What is confirmed is what is written.
    expect(keyOf({ ruleKind: "set-exact", value: "4" }, "JPY")).not.toBe(
      keyOf({ ruleKind: "set-exact", value: "4" }, "USD"),
    );
  });

  it("is what the action builds from the same rule", () => {
    const read = readCostForm(fields({ vendor: "Acme", value: "4" }), "USD");
    if (!read.ok) throw new Error("expected the form to read");

    expect(read.key).toBe(checkKeyOf("Acme", { kind: "percent-change", percent: 4 }));
  });
});

describe("whether a commit follows a check", () => {
  const key = keyOf({ value: "4" });

  it("lets through a commit carrying the check of its own values and a count", () => {
    expect(readCommit(key, fields({ checked: key, expected: "2699" }))).toEqual({
      ok: true,
      expected: 2699,
    });
  });

  it("refuses a commit that was never checked", () => {
    // What the button did before #754: commit straight from the form.
    const commit = readCommit(key, fields({}));

    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.message).toMatch(/have not been checked/);
    expect(commit.message).toMatch(/Press Check without changing/);
  });

  it.each(["", "two", "-1", "1.5"])("refuses a count of %j, which this page never sends", (expected) => {
    expect(readCommit(key, fields({ checked: key, expected })).ok).toBe(false);
  });

  it("refuses a commit whose form has moved since it was checked", () => {
    const commit = readCommit(keyOf({ value: "40" }), fields({ checked: key, expected: "12" }));

    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.message).toMatch(/no longer matches what was checked/);
  });
});

describe("the sentences, with their counts grouped", () => {
  it("says what a check found, in thousands where there are thousands", () => {
    expect(checkedMessage({ kind: "percent-change", percent: 4 }, { changed: 2699, matched: 3669 })).toBe(
      "Raise every matching cost by 4%: 2,699 of 3,669 would change. Nothing has been written.",
    );
  });

  it("says what a commit did", () => {
    expect(changedMessage(2699)).toBe("2,699 costs updated.");
    expect(changedMessage(1)).toBe("1 cost updated.");
  });

  it("names both counts when the catalogue moved between the check and the click", () => {
    expect(countMovedMessage(2700, 2699)).toBe(
      "2,700 costs would change now, not the 2,699 you were shown, so nothing was changed. " +
        "Check again and read the new count before changing them.",
    );
  });

  it("counts costs the way the confirmation's heading does", () => {
    expect(costCount(2699)).toBe("2,699 costs");
    expect(costCount(1)).toBe("1 cost");
  });

  it("names the scope the form narrowed to", () => {
    expect(costScopeOf("")).toBe("Every product");
    expect(costScopeOf("Acme")).toBe("Products from Acme");
  });
});
