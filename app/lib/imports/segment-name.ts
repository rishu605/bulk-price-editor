/**
 * The name of the frozen segment a spreadsheet campaign is built on (#719).
 *
 * Segment names are unique per shop, and the editor pre-fills every campaign with the same
 * name for the day ("Sale · 25/09/2026"), so the second import of the day collided with the
 * first's "(imported)" segment -- after the import had already been committed. Chosen
 * before anything is written, numbered the way a duplicate is: the second is "(imported 2)".
 */
export function importSegmentName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const first = `${name} (imported)`;
  if (!used.has(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (imported ${n})`;
    if (!used.has(candidate)) return candidate;
  }
}
