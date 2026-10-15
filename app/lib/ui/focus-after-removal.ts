/**
 * Where focus goes once the row a person acted on has left the table (#796).
 *
 * Resolving a drifted price or deleting a segment removes its row, and the focused button
 * went with it: focus fell to the page body, and a keyboard or screen-reader user was sent
 * back to the top of the admin to find their place. Now it lands on the row that took the
 * removed one's place -- the next, or the last if it was the end -- or, with none left, on
 * the table's own heading line.
 *
 * Browser-only, called from an effect after the list has re-rendered.
 */
export function focusAfterRemoval(table: Element | null, index: number, fallback: HTMLElement | null): void {
  const rows = table ? Array.from(table.querySelectorAll("s-table-row")) : [];
  const row = rows.length > 0 ? rows[Math.min(index, rows.length - 1)] : undefined;
  const control = row?.querySelector<HTMLElement>("s-button, s-link, s-checkbox");
  (control ?? fallback)?.focus();
}
