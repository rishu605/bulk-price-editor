/**
 * A money cell holds a number, and its qualifier goes underneath.
 *
 * ## What went wrong
 *
 * A money column is declared `format="currency"`, which right-aligns it, and the only
 * reason to right-align prices is so they line up on the decimal. Three tables then wrote
 * the qualifier into the same text run as the number — `` ` (was ${row.afterCompareAt})` ``
 * in the editor's preview panel and in the full-preview route, `` `${price} was ${cell.compareAt}` ``
 * in each market column of the review step.
 *
 * On screen, in the panel at its real width:
 *
 * ```
 *      Baseline        Would become
 *         10.02     8.02 (was 10.02)
 *         41.34        33.07 (was
 *                          41.34)
 *  1799.32 (was       1439.46 (was
 *     2598.79)           1799.32)
 * ```
 *
 * Two separate failures, and the wrapping is the less serious one. Because every suffix is
 * a different length, **no two prices in the column start at the same place** — the
 * alignment `format="currency"` was asked for is destroyed on precisely the rows that have
 * something to say. And row three reads "1799.32 (was 2598.79)" beside "1439.46 (was
 * 1799.32)": the same word pointing at the baseline's compare-at in one column and the
 * campaign's in the next.
 *
 * ## What is checked here
 *
 * The grep is deliberately narrow — the literal `(was ` and a `was ` glued to an
 * interpolation — because those are the two spellings that actually shipped, and a broad
 * rule against words in table cells would fail every legitimate one ("Not sold here",
 * "Already at this price", a skip reason). The `sourceOf` helper strips comments first, so
 * the paragraphs above do not trip the rule they describe. That has caught this repo out
 * seven times; see `app/lib/testing/source.ts`.
 *
 * The second test is the one that will save someone an afternoon. `alignItems="end"` on
 * `MoneyCell`'s stack looks like a stylistic flourish and is load-bearing: a stack is a
 * block that fills the cell and aligns its own children, so without it the number inside
 * stops taking the column's alignment and takes the stack's default instead — putting
 * every row that has a compare-at a few pixels left of every row that does not. It is
 * invisible in a diff and obvious in the admin, which is the combination worth pinning.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

interface Cell {
  file: string;
  body: string;
}

/** Every `s-table-cell` in the app, with its comments already stripped. */
function cells(): Cell[] {
  return tsxFiles(APP).flatMap((path) => {
    const source = sourceOf(path);
    return [...source.matchAll(/<s-table-cell[^>]*>([\s\S]*?)<\/s-table-cell>/g)].map(
      (match) => ({ file: path.replace(`${APP}/`, ""), body: match[1] }),
    );
  });
}

const CELLS = cells();

describe("a price and the price it is compared against are not one string", () => {
  it("finds the app's table cells", () => {
    // A floor, so adding a table is not a failing test. Ninety-odd when this landed.
    expect(CELLS.length).toBeGreaterThan(50);
  });

  it("never appends a parenthetical to a cell's value", () => {
    // A string literal opening with a space and a bracket — `" (current)"`,
    // `` ` (was ${row.afterCompareAt})` `` — is the shape of a suffix glued to whatever
    // expression precedes it. Both spellings shipped, in two different tables, so the
    // rule is written against the shape rather than against either wording: the next one
    // will be `" (est.)"` and nobody will remember this file.
    //
    // A parenthetical that is genuinely part of a label is written in the JSX, not in a
    // string beginning with a space, so this does not stand in the way of one.
    const offenders = CELLS.filter((cell) => /["'`] \(/.test(cell.body)).map(
      (cell) => cell.file,
    );

    expect(
      [...new Set(offenders)],
      "a suffix in the same text run as a number wraps mid-value and pushes it off the column's right edge — put it in MoneyCell's note or compareAt",
    ).toEqual([]);
  });

  it("never glues the word 'was' to an interpolated price", () => {
    // `${price} was ${cell.compareAt}` — the market-column spelling of the same bug.
    const offenders = CELLS.filter((cell) => /\}\s*was\s*\$\{/.test(cell.body)).map(
      (cell) => cell.file,
    );

    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe("MoneyCell keeps the alignment the currency format asked for", () => {
  const SOURCE = sourceOf("app/components/MoneyCell.tsx");

  it("aligns its stack to the inline end", () => {
    expect(
      /<s-stack[^>]*alignItems="end"/.test(SOURCE),
      "without this the number takes the stack's alignment instead of the column's, and rows with a compare-at sit left of rows without one",
    ).toBe(true);
  });

  it("renders a bare price without a stack at all", () => {
    // The ordinary cell is one number. Wrapping it in a layout element to serve the
    // exceptional case is how a table grows row height it did not need — and it is the
    // difference between a one-line and a two-line row on every clean row in the table.
    expect(SOURCE).toMatch(/if \(!struck && !note\) return/);
  });
});
