/**
 * Whether an import's commit button may act on the rows in the box now (#766).
 *
 * The button took its count from the last check while the textarea stayed editable, and
 * committing posts whatever the textarea holds at the time. So a merchant could check a
 * file, edit it, and press "Create a campaign from 4 rows" on rows nobody had checked:
 * the count was the old file's, and what it acted on was the new one.
 *
 * Kept apart from the component so the rule can be exercised without a DOM, which these
 * tests do not have. The component only supplies the three values.
 */

/** The rows a form would post, read the way a submit reads them. */
export function rowsOf(fields: FormData): string {
  const rows = fields.get("csv");
  return typeof rows === "string" ? rows : "";
}

/**
 * The count the commit button may offer, or null when it may offer nothing.
 *
 * - `ready`: rows the last check found ready, or null if no check has answered.
 * - `rows`: the rows in the box now, or null before the form has been read.
 * - `checked`: the rows that check read, or null when nothing on this form was checked.
 *
 * A check of other rows is no check of these, so anything but an exact match is null --
 * the same state as before the first check, which is what the merchant is back to.
 */
export function commitReady(ready: number | null, rows: string | null, checked: string | null): number | null {
  if (ready === null || rows === null || checked === null) return null;
  return rows === checked ? ready : null;
}
