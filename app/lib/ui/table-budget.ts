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
 * Cells we are confident render. Conservative on purpose: the cost of being wrong is a
 * blank page with nothing to diagnose it by, and the cost of being cautious is a few
 * fewer preview rows above a link to the full export.
 */
export const CELL_BUDGET = 150;

export function rowsThatFit(columns: number, hardMax = 100): number {
  if (columns <= 0) return hardMax;
  return Math.max(1, Math.min(hardMax, Math.floor(CELL_BUDGET / columns)));
}
