/**
 * No money is converted with a literal 100 outside `app/lib/money/`.
 *
 * A currency's minor units are 10 to the power of its own exponent: 100 for dollars, 1 for
 * yen, 1,000 for Kuwaiti dinar. `* 100` is right for exactly the currencies the code was
 * tested in, and wrong by a factor of 100 or 10 everywhere else, in a way that looks like
 * an ordinary number. It has now shipped three times: the campaign form (#343), the bulk
 * cost editor (#694) and the nightly mirror audit (#693), which parsed ¥1,980 as 198000
 * and then healed the mirror to it every night, unattended.
 *
 * `parseMoney` / `formatMoney` and `10 ** decimalsFor(currency)` are the ways to do it.
 * These patterns are deliberately about money-shaped operands (a parsed number, a money
 * amount, a price or cost), so percentages and basis points -- which are legitimately
 * hundreds -- do not trip them.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";

const HUNDRED_ON_MONEY = [
  /** `Number(node.price) * 100` -- a parsed decimal string turned into "minor units". */
  /Number\([^()]*\)\s*\*\s*100\b/,
  /** `money(Math.round(amount * 100), currency)`. */
  /money\(\s*Math\.round\([^()]*\*\s*100\s*\)/,
  /** `rule.amount.amount / 100`, and `Math.abs(x.amount) / 100`. */
  /\.amount\)?\s*\/\s*100\b/,
  /** `price * 100`, `cost * 100`, `amount * 100`. */
  /\b(price|compareAt|compareAtPrice|cost|amount)\s*\*\s*100\b/,
];

/**
 * Known offenders, each with the ticket that removes it.
 *
 * Listed rather than tolerated: the test below fails if a listed file stops matching, so
 * fixing #694 has to delete its line here too, and this list can only shrink.
 */
const KNOWN: Record<string, string> = {};

const offences = (source: string) =>
  HUNDRED_ON_MONEY.filter((pattern) => pattern.test(source)).map(String);

describe("money is never converted with a literal 100", () => {
  const files = sourceFiles("app").filter((file) => !file.startsWith("app/lib/money/"));

  it("found the tree, so this is not passing over an empty list", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("app/services/mirror-audit.server.ts");
  });

  it("catches the lines it was written for", () => {
    // The audit's own line from #693, and the cost editor's from #694. A guard whose
    // patterns cannot match the bug it names passes for the wrong reason.
    expect(offences("price: BigInt(Math.round(Number(node.price) * 100))")).not.toEqual([]);
    expect(offences("amount: money(Math.round(amount * 100), currency)")).not.toEqual([]);
    expect(offences("`Set every matching cost to ${(rule.amount.amount / 100).toFixed(2)}`")).not.toEqual([]);
  });

  it("leaves percentages and basis points alone", () => {
    expect(offences("const magnitude = Math.round(adjustment.value * 100);")).toEqual([]);
    expect(offences("const percent = Math.abs(bps) / 100;")).toEqual([]);
    expect(offences("ratePercent: Number((verdict.rate * 100).toFixed(2))")).toEqual([]);
  });

  it.each(files.filter((file) => !(file in KNOWN)))("%s converts money by its currency", (file) => {
    expect(offences(sourceOf(file))).toEqual([]);
  });

  it.each(Object.entries(KNOWN))("%s is still a known offender (%s); drop it from the list once fixed", (file) => {
    expect(offences(sourceOf(file))).not.toEqual([]);
  });
});
