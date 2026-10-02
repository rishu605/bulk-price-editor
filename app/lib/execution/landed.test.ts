/**
 * Every reader of "what did we put on the storefront" counts clamped rows (#792).
 *
 * A clamped price is written and read back, and since #792 it is recorded as CLAMPED
 * rather than VERIFIED. That makes it two halves of a contract: the writer records two
 * states, and each reader has to accept both. A query that still says `"VERIFIED"` on its
 * own compiles and passes every test without a clamp in it -- and then drift detection
 * takes our own write for an edit made elsewhere. So the source is read for it.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";
import { isLanded, LANDED } from "./landed";

/** The argument text of each read call on the ledger in a file. */
function ledgerReads(source: string): string[] {
  const found: string[] = [];
  const call = /variantChange\.(findMany|findFirst|findFirstOrThrow|findUnique|count|aggregate|groupBy)\(/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")" && --depth === 0) break;
    }
    found.push(source.slice(start, i + 1));
  }
  return found;
}

const files = sourceFiles("app").filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("/types/"));

describe("what landed on the storefront", () => {
  it("is a verified write or a clamped one", () => {
    expect(LANDED).toEqual(["VERIFIED", "CLAMPED"]);
    expect(isLanded("CLAMPED")).toBe(true);
    expect(isLanded("APPLIED"), "written, never read back").toBe(false);
    expect(isLanded("SKIPPED")).toBe(false);
  });

  it("finds the ledger readers at all, so a rename cannot empty this check", () => {
    const reads = files.flatMap((file) => ledgerReads(sourceOf(file)));
    expect(reads.length).toBeGreaterThanOrEqual(15);
    expect(reads.filter((args) => args.includes("LANDED")).length).toBeGreaterThanOrEqual(8);
  });

  it.each(files.map((file) => [file]))("%s never reads the ledger for VERIFIED alone", (file) => {
    const source = sourceOf(file);

    for (const args of ledgerReads(source)) {
      if (!args.includes('"VERIFIED"')) continue;
      expect(
        args.includes('"CLAMPED"'),
        `${file} reads the ledger for VERIFIED rows without CLAMPED ones; use \`LANDED\` from ` +
          `app/lib/execution/landed.ts, or a clamped price is invisible to it:\n${args}`,
      ).toBe(true);
    }

    // Raw SQL over the ledger, which the call scan above cannot see.
    expect(
      source,
      `${file} has raw SQL comparing the ledger status to 'VERIFIED' alone; use IN ('VERIFIED', 'CLAMPED')`,
    ).not.toMatch(/"status"\s*=\s*'VERIFIED'/);
  });
});
