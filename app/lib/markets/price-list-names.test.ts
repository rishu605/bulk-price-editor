/**
 * No price list reaches a merchant under Shopify's own name for it (#722).
 *
 * Shopify names a market's implicit price list `pricing_by_market.19853246698_1786915628`.
 * `priceListLabel` (#642) fixed the editor, then What's live printed the raw name in its
 * filter and its Surface column, a refused market in a run said "pricing_by_market.… returned
 * prices that are not in CAD", and a market notice quoted it too. Each one read the mirror's
 * `name` and passed it on.
 *
 * So the rule is at the read: every query of `priceListRecord` that can return `name` labels
 * what it returns, in the same statement, with `labelled`. A file that keeps Shopify's name
 * on purpose is listed below with the reason.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";

/** Files that read the raw name deliberately, and where it gets its label instead. */
const KEEPS_SHOPIFY_NAME: Record<string, string> = {
  "app/services/markets-topology.server.ts":
    "the snapshot keeps Shopify's name for the audit log; `diffTopology` labels every change it reports",
};

/** Each `priceListRecord.find…(` call with its argument and the rest of its statement. */
function reads(source: string): Array<{ call: string; statement: string }> {
  const found: Array<{ call: string; statement: string }> = [];
  for (const match of source.matchAll(/priceListRecord\.find\w*\(/g)) {
    const open = match.index! + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === "(") depth += 1;
      if (source[close] === ")" && --depth === 0) break;
    }
    // The statement runs on until a semicolon, or a comma no deeper than the call, which
    // covers `(await …).map(labelled);` -- through the paren the call sits inside -- and
    // `….then((rows) => rows.map(labelled)),` in a `Promise.all`.
    let end = close + 1;
    let level = 0;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if ("([{".includes(char)) level += 1;
      if (")]}".includes(char)) level -= 1;
      if (char === ";" || (char === "," && level <= 0)) break;
    }
    found.push({ call: source.slice(match.index!, close + 1), statement: source.slice(match.index!, end) });
  }
  return found;
}

/** Whether a read can return `name`: no `select`, or one that asks for it. */
const returnsName = (call: string) => !/\bselect\s*:/.test(call) || /\bname\s*:\s*true\b/.test(call);

describe("price list names", () => {
  const files = sourceFiles("app").filter((file) => !/ \d+\.tsx?$/.test(file));

  it("are labelled wherever the mirror is read for them", () => {
    const unlabelled: string[] = [];
    let checked = 0;
    for (const file of files) {
      if (file in KEEPS_SHOPIFY_NAME) continue;
      for (const { call, statement } of reads(sourceOf(file))) {
        if (!returnsName(call)) continue;
        checked += 1;
        if (!/\blabelled\b/.test(statement)) unlabelled.push(`${file}: ${call.slice(0, 60)}…`);
      }
    }
    expect(checked, "the guard found no reads to check").toBeGreaterThan(3);
    expect(unlabelled, "reads Shopify's name for a price list without labelling it").toEqual([]);
  });

  it("are kept raw only where a reason is written down, and the file still reads the name", () => {
    for (const [file, reason] of Object.entries(KEEPS_SHOPIFY_NAME)) {
      expect(reason).toMatch(/\S/);
      expect(reads(sourceOf(file)).some(({ call }) => returnsName(call)), `${file} no longer needs its exemption`).toBe(true);
    }
  });
});
