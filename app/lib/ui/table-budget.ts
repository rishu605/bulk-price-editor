/**
 * How many rows a Polaris `s-table` can be given before it stops rendering.
 *
 * Not a style preference. Past roughly a few hundred cells, `s-table` blanks the entire
 * page — not the table, the page — with no error and no console message, because the
 * console belongs to a cross-origin iframe. It was found by bisection: five rows fine,
 * fifty-six not.
 *
 * That makes it a cell budget rather than a row limit, which matters the moment a table
 * grows columns. A per-surface preview with three markets has twice the columns of a
 * base-only one, so the same row count is twice the cells. Deriving rows from columns
 * keeps a merchant who added a market from losing the preview entirely.
 */

/**
 * How many rows a table shows before it starts paging.
 *
 * A different question from `CELL_BUDGET` below, and they are easy to conflate. That one
 * is "how many rows can Polaris render before the page goes blank" — a hard limit with a
 * bug behind it. This is "how many rows should a merchant be shown at once", which is a
 * judgement about the page they are standing on.
 *
 * The app had four answers to it: 50 on the catalogue, 25 on baselines and activity, 100
 * on drift, 200 in a run's ledger, and every row there is on the reconciliation table and
 * the rollback report. The consequence is what a merchant sees: the *page* scrolls, for
 * screens at a time, with the table's own header long gone off the top and the controls
 * that filter it further still. A table that runs past the fold has stopped being a table
 * and become a document.
 *
 * Fifteen is about a screen of rows inside the admin's frame, with room for the filters
 * above and the pager below. It is one constant on purpose: it is a number to be retuned
 * by looking at the thing, and retuning it should be one edit rather than nine.
 *
 * ## Why the rows are capped rather than the table scrolled
 *
 * The obvious fix is a fixed-height box with `overflow-y: auto`, and Polaris does not
 * offer one: `s-box` takes `overflow: 'hidden' | 'visible'` and nothing else. Reaching for
 * a native `div` would mean giving up two things that matter more than an inner
 * scrollbar. The header row lives inside Polaris' shadow DOM, so it could not be made to
 * stick, and a merchant scrolling a long table would lose the column names — which is the
 * entire reason a scroll region beats paging. And `s-table` decides for itself whether to
 * render a grid or a stack of key-value rows; a stacked list inside a fixed-height
 * scroller is not a design anybody chose.
 */
export const ROWS_PER_VIEW = 15;

/**
 * Cells we are confident render. Conservative on purpose: the cost of being wrong is a
 * blank page with nothing to diagnose it by, and the cost of being cautious is a few
 * fewer preview rows above a link to the full export.
 */
export const CELL_BUDGET = 150;

export function rowsThatFit(columns: number, hardMax = 100): number {
  if (columns <= 0) return hardMax;
  return Math.max(1, Math.min(hardMax, Math.floor(CELL_BUDGET / columns)));
}
