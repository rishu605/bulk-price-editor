/**
 * The sentences a check-then-commit import answers with, for the baseline and cost files.
 *
 * Both routes wrote the same three by hand -- "Import 1 baselines", "Imported 1 costs",
 * "3669 rows would be imported" -- so a count that agrees with one and is grouped like
 * every other number in the app has one place to be right (#759).
 */

import { countOf, formatCount } from "../format/display";

/** The commit button: "Import 3,669 baselines", "Import 1 cost". */
export function importLabel(ready: number, noun: string): string {
  return `Import ${countOf(ready, noun)}`;
}

/** What a check found: how many of the file's rows would be imported, and that none were. */
export function importCheckMessage(ready: number, total: number): string {
  return `${formatCount(ready)} of ${countOf(total, "row")} would be imported. Nothing has been written.`;
}

/** What a commit did: what it wrote, and what it left alone because it already matched. */
export function importedMessage(written: number, noun: string, unchanged: number): string {
  return (
    `Imported ${countOf(written, noun)}.` +
    (unchanged > 0
      ? ` ${formatCount(unchanged)} already matched and ${unchanged === 1 ? "was" : "were"} left alone.`
      : "")
  );
}
