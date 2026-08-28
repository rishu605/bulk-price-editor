/**
 * Every table is designed for both of the shapes Polaris can render it in.
 *
 * `s-table` chooses between a grid and a stack of key-value pairs itself. App Home
 * narrows `variant` to `list | auto`, so there is no way to pin the grid, and a container
 * near the ~490px threshold resolves inconsistently between reloads — the campaigns index
 * at ~566px renders both ways on the same URL. See `docs/polaris-notes.md`.
 *
 * That is Polaris' call. What is ours is that the collapsed shape be worth looking at,
 * and by default it is not: `listSlot` defaults to `labeled`, so an undesignated table
 * stacks every column into a heading-content pair and a variant row becomes eight
 * "SKU: ANC-1" pairs with the product's own name carrying no more weight than its
 * compare-at price.
 *
 * ## The rule this file enforces
 *
 * - **Exactly one `primary`** — the row's identity. The name, the reference, the thing a
 *   merchant would say aloud to name the row. Polaris allows only one and silently takes
 *   the last, so two is not a stylistic disagreement; it is a column losing its slot.
 * - **At most one `secondary` and one `kicker`**, for the same reason.
 * - **Every header designated explicitly.** Not because `labeled` is always wrong — it is
 *   right for most columns — but because the default is what an unconsidered table looks
 *   like, and the two are indistinguishable in a diff.
 * - **A money column is `currency`, a count column is `numeric`.** Both right-align. In a
 *   pricing app this is not decoration: four price columns sit side by side on the
 *   catalogue page, and left-aligned they do not line up on the decimal, which is the
 *   one alignment that makes a column of prices scannable.
 *
 * The format check runs off a list of labels this app actually uses rather than off a
 * pattern. A new column with a new name is not failed by it — the list locks in what has
 * been decided, and does not stand in the way of deciding about something else.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

interface Header {
  /** Everything between `<s-table-header` and its closing `>`. */
  attributes: string;
  /** The header's own text, trimmed. Empty for a spacer column. */
  label: string;
}

interface Table {
  file: string;
  headers: Header[];
}

/**
 * Every header row in the app, with its headers.
 *
 * `<s-table-header(?!-)` rather than a word boundary: `\b` matches between `r` and `-`,
 * so the obvious spelling also matches `<s-table-header-row` and every table would
 * appear to have one extra, undesignated column.
 */
function tables(): Table[] {
  return tsxFiles(APP).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const file = path.replace(`${APP}/`, "");

    return [...source.matchAll(/<s-table-header-row[^>]*>([\s\S]*?)<\/s-table-header-row>/g)].map(
      (row) => ({
        file,
        headers: [
          ...row[1].matchAll(/<s-table-header(?!-)([^>]*)>([\s\S]*?)<\/s-table-header>/g),
        ].map((header) => ({
          attributes: header[1],
          label: header[2].replace(/\s+/g, " ").trim(),
        })),
      }),
    );
  });
}

const slotOf = (header: Header) => /listSlot="([a-z]+)"/.exec(header.attributes)?.[1] ?? null;
const formatOf = (header: Header) => /format="([a-z]+)"/.exec(header.attributes)?.[1] ?? null;

const ALL = tables();
const describeTable = (table: Table, index: number) => `${table.file} (table ${index + 1})`;

describe("every table is designed for the shape Polaris might collapse it into", () => {
  it("finds the app's tables", () => {
    // Nineteen when this landed. A floor rather than an equality, so adding a table is
    // not a failing test — shipping an undesignated one is, which is the check below.
    expect(ALL.length).toBeGreaterThanOrEqual(19);
    expect(ALL.every((table) => table.headers.length > 0)).toBe(true);
  });

  it("designates every column, so no table falls back to the default by accident", () => {
    const offenders = ALL.flatMap((table, index) =>
      table.headers.some((header) => slotOf(header) === null) ? [describeTable(table, index)] : [],
    );

    expect(
      offenders,
      "these have a column with no listSlot, which stacks as a labelled pair whether or not anyone chose that",
    ).toEqual([]);
  });

  it("names exactly one primary column per table", () => {
    const offenders = ALL.flatMap((table, index) => {
      const primaries = table.headers.filter((header) => slotOf(header) === "primary");
      return primaries.length === 1
        ? []
        : [`${describeTable(table, index)}: ${primaries.length} primary columns`];
    });

    expect(
      offenders,
      "Polaris allows one primary and takes the last of any others, so a second one silently unslots a column",
    ).toEqual([]);
  });

  it("names at most one secondary and one kicker per table", () => {
    const offenders = ALL.flatMap((table, index) =>
      (["secondary", "kicker"] as const).flatMap((slot) => {
        const count = table.headers.filter((header) => slotOf(header) === slot).length;
        return count > 1 ? [`${describeTable(table, index)}: ${count} ${slot} columns`] : [];
      }),
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * Columns whose alignment has been decided, by the label they carry.
 *
 * Money and counts both right-align, and which one a column is says what it holds — so
 * they are listed separately even though Polaris renders the alignment the same way.
 */
const MONEY = [
  "Baseline", "Live", "Live price", "Live now", "Before", "After", "Intended", "Compare at",
  "Cost", "Price", "We applied", "Reverts to", "Campaign set", "Now shows", "Now",
  "Would become",
];

const COUNTS = [
  "Planned", "Verified", "Failed", "Rows read", "Matched a variant", "Line", "Products",
  "Priority", "Variants", "Variants in this scope",
];

describe("a column of numbers is right-aligned", () => {
  const headersLabelled = (labels: string[]) =>
    ALL.flatMap((table, index) =>
      table.headers
        .filter((header) => labels.includes(header.label))
        .map((header) => ({ where: describeTable(table, index), header })),
    );

  it("has money columns to check, and counts", () => {
    expect(headersLabelled(MONEY).length).toBeGreaterThan(15);
    expect(headersLabelled(COUNTS).length).toBeGreaterThan(8);
  });

  it("formats every money column as currency", () => {
    const offenders = headersLabelled(MONEY)
      .filter(({ header }) => formatOf(header) !== "currency")
      .map(({ where, header }) => `${where}: ${header.label}`);

    expect(
      offenders,
      "a price column that is not right-aligned does not line up on the decimal with the price column beside it",
    ).toEqual([]);
  });

  it("formats every count column as numeric", () => {
    const offenders = headersLabelled(COUNTS)
      .filter(({ header }) => formatOf(header) !== "numeric")
      .map(({ where, header }) => `${where}: ${header.label}`);

    expect(offenders).toEqual([]);
  });
});
