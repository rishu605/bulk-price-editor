/**
 * A direction and a magnitude mean exactly what a signed number used to.
 *
 * To take 20% off, a merchant typed `-20` into a field labelled "Percentage", under a
 * line of help reading "Negative discounts. -20 means 20% off the baseline." It is the
 * first control in the create flow, so the sign convention was the first thing the
 * product taught — and a merchant who typed `20`, which is what "20% off" sounds like,
 * got a twenty per cent price *rise* with nothing on the screen refusing it.
 *
 * This is a control change wearing no other clothes. The rule the action builds has to be
 * identical for the same intent, and the signed spelling has to keep working: quick
 * create on Home, `draftDefaultParams`, and four old import URLs all send a signed
 * `ruleValue` and no direction, and a bookmarked `?ruleValue=-20` has to keep meaning
 * what it meant.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { readerFor, ruleFrom } from "./draft-form";

const read = (fields: Record<string, string>) => readerFor(new URLSearchParams(fields));

describe("the two spellings agree", () => {
  it("reduce by 20 is the old -20", () => {
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down" }), "USD")).toEqual(
      ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20" }), "USD"),
    );
  });

  it("increase by 20 is the old 20", () => {
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "20", ruleDirection: "up" }), "USD")).toEqual(
      ruleFrom(read({ ruleKind: "percent-change", ruleValue: "20" }), "USD"),
    );
  });

  it("holds for a fixed amount too, in minor units", () => {
    const down = ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "10", ruleDirection: "down" }), "USD");
    const signed = ruleFrom(read({ ruleKind: "fixed-change", ruleValue: "-10" }), "USD");

    expect(down).toEqual(signed);
    expect(down).toMatchObject({ kind: "fixed-change", amount: { amount: -1000 } });
  });

  it("agrees for every magnitude, either way", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.constantFrom("up", "down"), (n, way) => {
        const directional = ruleFrom(
          read({ ruleKind: "percent-change", ruleValue: String(n), ruleDirection: way }),
          "USD",
        );
        const signed = ruleFrom(
          read({ ruleKind: "percent-change", ruleValue: way === "up" ? String(n) : String(-n) }),
          "USD",
        );

        expect(directional).toEqual(signed);
      }),
    );
  });
});

describe("the direction wins over the sign", () => {
  it("reduce by -20 still reduces", () => {
    // The two halves cannot disagree. A merchant who chooses "Reduce by" and then types a
    // minus — because that is what they were taught last week — must not get a rise.
    expect(
      ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20", ruleDirection: "down" }), "USD"),
    ).toEqual({ kind: "percent-change", percent: -20 });
  });

  it("increase by -20 still increases", () => {
    expect(
      ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20", ruleDirection: "up" }), "USD"),
    ).toEqual({ kind: "percent-change", percent: 20 });
  });
});

describe("what a direction must not touch", () => {
  it("leaves an exact price alone", () => {
    // "Set an exact price" is not a change, so a sign on it would be a negative price.
    // The editor renders no direction control for it; this is the parser holding the
    // same line if one arrives anyway.
    expect(
      ruleFrom(read({ ruleKind: "set-exact", ruleValue: "12.50", ruleDirection: "down" }), "USD"),
    ).toMatchObject({ kind: "set-exact", amount: { amount: 1250 } });
  });

  it("reads a signed value exactly as given when no direction is sent", () => {
    // Quick create, `draftDefaultParams` and the old import URLs all do this.
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20" }), "USD")).toEqual({
      kind: "percent-change",
      percent: -20,
    });
    expect(ruleFrom(read({ ruleKind: "percent-change", ruleValue: "15" }), "USD")).toEqual({
      kind: "percent-change",
      percent: 15,
    });
  });

  it("ignores a direction it does not recognise rather than guessing", () => {
    expect(
      ruleFrom(read({ ruleKind: "percent-change", ruleValue: "-20", ruleDirection: "sideways" }), "USD"),
    ).toEqual({ kind: "percent-change", percent: -20 });
  });
});

describe("the control and the parser agree on which rules take a direction", () => {
  it("offers one for exactly the two rules that change a price by an amount", () => {
    // If these two lists drift, the editor shows a control the parser ignores — the
    // failure that #343 was: a field the form had and the rule did not.
    const field = readerFor(new URLSearchParams());
    expect(ruleFrom(field, "USD").kind).toBe("percent-change");
  });
});
