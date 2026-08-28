/**
 * No table makes the page scroll, and no table lies about what it is not showing.
 *
 * The app had six answers to "how many rows is a table": 50 on the catalogue, 25 on
 * baselines, activity and what's-live, 100 on drift, 200 in a run's ledger, and every row
 * there is on the rollback report. Three of those were rendered with no way to reach the
 * next page and nothing on screen saying there was one, so the *page* scrolled for screens
 * at a time and the table's own header was long gone off the top.
 *
 * Two rules come out of that, and both are checked here rather than in prose:
 *
 * - **One number decides how many rows a view holds.** Nine places deciding it separately
 *   is how they came to disagree, and the disagreement is invisible in any one file.
 * - **A capped table says so.** A table showing fifteen of fifteen and a table showing
 *   fifteen of three thousand look identical, and the second one silently answers "these
 *   are all of them" to a merchant checking their prices.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROWS_PER_VIEW, rowsThatFit, CELL_BUDGET } from "./table-budget";
import { rowsToShow } from "../../components/RollbackReportTable";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** Source without its own commentary, so a file explaining a number is not read as setting one. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FILES = sources("app").map((path) => ({ path, source: code(read(path)) }));

describe("one number decides how many rows a view holds", () => {
  it("is small enough to be a view rather than a document", () => {
    expect(ROWS_PER_VIEW).toBeGreaterThan(5);
    expect(ROWS_PER_VIEW).toBeLessThanOrEqual(25);
  });

  it("is what every paging page uses", () => {
    // `PAGE_SIZE` is declared in five services and routes. Each was a different literal.
    const sizes = FILES.flatMap(({ path, source }) =>
      [...source.matchAll(/PAGE_SIZE = ([^;\n]+)/g)].map((m) => `${path}: ${m[1].trim()}`),
    );

    expect(sizes.length).toBeGreaterThanOrEqual(5);
    expect(sizes.filter((entry) => !entry.endsWith("ROWS_PER_VIEW"))).toEqual([]);
  });

  /**
   * Every `take:` in the app that is *not* a table's page size, and why.
   *
   * Written out with reasons rather than filtered by a number, because the numbers are
   * not the point: `take: 50` is a filter's option list in one file and would be an
   * uncapped table in another. An entry here is a claim that this particular query does
   * not put rows on a screen, and it has to be made deliberately.
   */
  const NOT_A_TABLE: Record<string, string> = {
    "app/routes/app._index.tsx: take: 5":
      "the dashboard's activity summary, which links to the full log",
    "app/routes/app._index.tsx: take: 8":
      "the dashboard's upcoming campaigns, which links to the calendar",
    "app/services/activity.server.ts: take: 50": "distinct actors, for the Who dropdown",
    "app/services/activity.server.ts: take: 100": "distinct actions, for the What dropdown",
    "app/services/alerting.server.ts: take: 500": "operator alerting, which has no screen",
    "app/services/baseline-browser.server.ts: take: 50":
      "the vendor and source dropdowns, and one variant's own baseline history — the " +
      "forensic view, where truncating is the opposite of what it is for",
    "app/services/campaigns/list.server.ts: take: 1":
      "each campaign's newest run, joined onto the row it belongs to",
    "app/services/campaigns/rollback-report.server.ts: take: 20":
      "the last APPLY runs to read applied values from, not rows",
    "app/services/cost-edit.server.ts: take: 10_000":
      "the bulk edit's working set, which is written rather than shown",
    "app/services/reconciliation.server.ts: take: 100": "campaign names, for the filter dropdown",
    "app/services/reconciliation.server.ts: take: 500":
      "variant ids matching a search, narrowing the row query rather than being rows",
    "app/services/reconciliation.server.ts: take: 5_000":
      "variant ids a campaign controls, narrowing the row query",
  };

  it("leaves no hand-written row limit behind", () => {
    const found = FILES.flatMap(({ path, source }) =>
      [...source.matchAll(/take: (\d[\d_]*)/g)].map((m) => `${path}: take: ${m[1]}`),
    );

    const offenders = [...new Set(found)].filter((entry) => !(entry in NOT_A_TABLE));

    expect(
      offenders,
      "these cap a table with a literal instead of ROWS_PER_VIEW — or are not tables, " +
        "in which case add them to NOT_A_TABLE with the reason",
    ).toEqual([]);
  });

  it("keeps that list honest by requiring each entry to still exist", () => {
    const found = new Set(
      FILES.flatMap(({ path, source }) =>
        [...source.matchAll(/take: (\d[\d_]*)/g)].map((m) => `${path}: take: ${m[1]}`),
      ),
    );

    const stale = Object.keys(NOT_A_TABLE).filter((entry) => !found.has(entry));
    expect(stale, "these are excused but no longer there").toEqual([]);
  });
});

describe("the cell budget is a different question and stays one", () => {
  it("still shrinks the row count as columns grow", () => {
    // A per-surface preview with three markets has twice the columns of a base-only one,
    // so the same row count is twice the cells — and past the budget the page goes blank.
    expect(rowsThatFit(3)).toBeGreaterThan(rowsThatFit(9));
    expect(rowsThatFit(1)).toBeLessThanOrEqual(100);
  });

  it("is a hard limit, not a preference, and is not ROWS_PER_VIEW", () => {
    expect(CELL_BUDGET).toBeGreaterThan(ROWS_PER_VIEW);
  });
});

describe("a table that cannot show everything says so", () => {
  const CAPPED = [
    ["components/LedgerTable.tsx", "a run wrote more rows than the ledger renders"],
    ["components/PreviewTable.tsx", "rowsThatFit caps the preview, and shrinks it per market"],
    ["components/RollbackReportTable.tsx", "clean rows are capped; decisions are not"],
    ["routes/app.prices.drift.tsx", "the queue shows a page of pending decisions"],
    ["routes/app.settings.segments.tsx", "the match report lists the first rows only"],
  ] as const;

  it.each(CAPPED)("app/%s says what it is not showing (%s)", (path) => {
    expect(read("app", path)).toContain("<ShowingSome");
  });

  it("says nothing when there is nothing left out", () => {
    // The component returns null rather than "showing 3 of 3", which is noise on every
    // small table in the app.
    const source = read("app/components/Pagination.tsx");
    expect(source).toContain("if (total <= shown) return null;");
  });
});

describe("the rollback report never hides a decision", () => {
  /**
   * Checked by running it, not by reading it.
   *
   * The first version of this asserted the source contained the filter that separates
   * decisions from clean rows — and a mutant that appended `.slice(0, 5)` to that very
   * filter passed, because the substring was still there. An assertion about the shape of
   * a line cannot see what the line does, and what this line does is decide whether a
   * merchant is shown a choice about somebody's deliberate price edit.
   */
  const row = (kind: "drifted" | "deleted" | "clean", n: number) =>
    ({ variantGid: `gid/${kind}/${n}`, kind }) as never;

  const many = (kind: "drifted" | "deleted" | "clean", count: number) =>
    Array.from({ length: count }, (_, i) => row(kind, i));

  it("shows every drifted row, however many there are", () => {
    const rows = [...many("drifted", 200), ...many("clean", 3_000)];
    const shown = rowsToShow(rows);

    expect(shown.filter((r) => r.kind === "drifted")).toHaveLength(200);
  });

  it("shows every deleted row too — that is also a thing to know before reverting", () => {
    const shown = rowsToShow([...many("deleted", 40), ...many("clean", 1_000)]);

    expect(shown.filter((r) => r.kind === "deleted")).toHaveLength(40);
  });

  it("caps the clean rows, which are reassurance rather than decisions", () => {
    const shown = rowsToShow([...many("drifted", 2), ...many("clean", 3_000)]);

    expect(shown.filter((r) => r.kind === "clean").length).toBeLessThanOrEqual(ROWS_PER_VIEW);
    expect(shown.length).toBeLessThanOrEqual(ROWS_PER_VIEW);
  });

  it("gives up its clean rows first when the decisions alone fill the view", () => {
    const shown = rowsToShow([...many("drifted", ROWS_PER_VIEW + 5), ...many("clean", 100)]);

    expect(shown.filter((r) => r.kind === "clean")).toHaveLength(0);
    expect(shown).toHaveLength(ROWS_PER_VIEW + 5);
  });

  it("shows a short report whole", () => {
    const rows = [...many("drifted", 1), ...many("clean", 3)];

    expect(rowsToShow(rows)).toHaveLength(4);
  });

  it("puts the decisions first, where a merchant reading top-down meets them", () => {
    const shown = rowsToShow([...many("clean", 20), ...many("drifted", 2)]);

    expect(shown.slice(0, 2).every((r) => r.kind === "drifted")).toBe(true);
  });
});

describe("every paged table has a control to reach the next page", () => {
  const PAGED = [
    "routes/app.prices._index.tsx",
    "routes/app.prices.baselines._index.tsx",
    "routes/app.prices.live.tsx",
    "routes/app.activity.tsx",
  ];

  it.each(PAGED)("app/%s renders a pager", (path) => {
    // What's-live had been paged server-side since it was written, with no pager: the
    // loader read `?page=`, the service returned a total, and row 26 was reachable only
    // by typing a URL a merchant never sees.
    expect(read("app", path)).toContain("<Pagination");
  });
});
