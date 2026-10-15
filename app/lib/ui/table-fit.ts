/**
 * Whether a table should be drawn as a grid or as a list, from what it measures.
 *
 * ## Why this has to be decided here at all (#804)
 *
 * `s-table` chooses its own layout, and it does not choose from the table's width. From
 * `polaris.js`:
 *
 *     function Nm(e) { return "list" === e ? "list" : window.innerWidth >= 490 ? "table" : "list" }
 *
 * The **frame's** width, against a fixed 490px. No container query is involved, so no
 * `s-query-container` changes it -- this is not the #612 / #638 / #725 family it looks
 * like. A table on a page narrower than its columns stays a grid, and the grid sits in a
 * box that scrolls sideways and clips at the card's edge. On the deployed What's live page
 * at 606px that was "708.7" for 708.76, with the scrollbar at the foot of the table, a
 * screen below, and the Campaign column out of view once anyone found it.
 *
 * The one lever App Home leaves is `variant`, which takes `list` or `auto` and nothing
 * else (`docs/polaris-notes.md`). So the app measures and asks: a table whose grid is
 * wider than the space it was given is asked for its list, and every table here is
 * already designed for that shape (`table-designation.test.ts`).
 *
 * ## Why the width that made it a list is remembered
 *
 * A list has no grid to measure, so once a table is a list there is no way to ask "would
 * the grid fit now?" except to draw it and look. Remembering how wide the grid was when it
 * did not fit answers that without a flicker: the table goes back to `auto` only once it is
 * given at least that much room. If its rows changed meanwhile and the grid is wider now,
 * the next measurement sends it straight back, with the new width remembered.
 */

/** A pixel of rounding is not a table that does not fit. */
export const FIT_TOLERANCE_PX = 1;

export interface TableMeasurement {
  /** What Polaris drew: a grid, or a stack of labelled pairs. */
  layout: "table" | "list";
  /** The width the table was given. Zero when it is not on screen -- a closed tab, a modal. */
  available: number;
  /** The grid's own width, when it is drawn as one. */
  grid: number | null;
  /** The grid's width when this table was last asked for a list, if it was. */
  needed: number | null;
}

/** What to ask the table for, and what to remember. `null` means leave it alone. */
export type TableFit = { variant: "list"; needed: number } | { variant: "auto"; needed: null } | null;

export function fitTable({ layout, available, grid, needed }: TableMeasurement): TableFit {
  // Nothing to measure against. A hidden table is zero wide and would read as one that
  // fits nothing.
  if (available <= 0) return null;

  if (layout === "table") {
    return grid !== null && grid > available + FIT_TOLERANCE_PX ? { variant: "list", needed: grid } : null;
  }

  // A list this did not ask for is Polaris' own choice -- a frame under 490px -- and stays.
  if (needed === null) return null;

  return available >= needed ? { variant: "auto", needed: null } : null;
}
