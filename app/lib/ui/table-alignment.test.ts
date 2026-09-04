/**
 * A number aligns on its last digit; a word aligns on its first letter.
 *
 * `s-table-header` takes `format` — `base`, `currency` or `numeric` — and Polaris applies
 * the alignment and the tabular figures from it. Whether a column got one was decided per
 * table, so the rule existed in thirty-six places and nowhere.
 *
 * The plans table is what prompted this: three right-aligned columns then three
 * left-aligned ones, which looks arbitrary and is not — "Price a month" and "Variants"
 * are numbers, "Markets", "Wholesale" and "Trial" are words. It is following the rule. The
 * point of writing it down is the column that does not, later.
 *
 * ## What this cannot fix
 *
 * The gutters. "Markets" holds "—" or "Yes" in a column as wide as its heading, so the
 * value sits alone at the far left of a lot of space. `TableHeaderProps` has exactly three
 * props — `children`, `listSlot`, `format` — and no width, so column widths are Polaris'
 * to decide and there is no API through which to narrow one. Recorded here rather than
 * left as a mystery for whoever looks next.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");

function sources(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ path: path.replace(`${APP}/`, ""), source: sourceOf(path) }];
  });
}

/** Every `<s-table>…</s-table>` in a file. */
function tables(source: string): string[] {
  return [...source.matchAll(/<s-table>[\s\S]*?<\/s-table>/g)].map((match) => match[0]);
}

/** The headers of one table, in order, with whether each is formatted as a number. */
function headers(table: string): Array<{ label: string; formatted: boolean }> {
  return [...table.matchAll(/<s-table-header([^>]*)>([\s\S]*?)<\/s-table-header>/g)].map(
    (match) => ({
      label: match[2].replace(/\s+/g, " ").trim(),
      formatted: /format="(currency|numeric)"/.test(match[1]),
    }),
  );
}

/** The cells of the table's first body row, in order. */
function firstRowCells(table: string): string[] {
  const body = table.slice(table.indexOf("<s-table-body>"));
  const row = /<s-table-row[^>]*>([\s\S]*?)<\/s-table-row>/.exec(body);
  if (!row) return [];
  return [...row[1].matchAll(/<s-table-cell>([\s\S]*?)<\/s-table-cell>/g)].map((cell) => cell[1]);
}

/** A cell whose content is a rendered number or amount. */
const NUMERIC_CELL = /formatCount\(|<MoneyCell|\.amount\b|formatMoney/;

describe("numeric columns say so", () => {
  const all = sources(APP).flatMap(({ path, source }) =>
    tables(source).map((table) => ({ path, table })),
  );

  it("finds the tables, so this cannot pass by checking nothing", () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it("a column of numbers carries a format, so Polaris right-aligns it", () => {
    const offenders = all.flatMap(({ path, table }) => {
      const columns = headers(table);
      const cells = firstRowCells(table);

      return cells.flatMap((cell, index) => {
        const column = columns[index];
        if (!column || column.formatted) return [];
        if (!NUMERIC_CELL.test(cell)) return [];
        return [`${path}: "${column.label}"`];
      });
    });

    expect(
      offenders,
      'a column of numbers without format="numeric" aligns on its first digit, so 9 and 1,024 start in the same place',
    ).toEqual([]);
  });
});
