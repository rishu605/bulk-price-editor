/**
 * What a duplicate is called.
 *
 * Duplicate is not recurrence. Recurrence re-arms the same campaign for its next
 * occurrence and keeps one history; duplicate is how a merchant builds *next month's
 * different sale* out of *last month's sale that worked*. So the name has to say where
 * this one came from, and it has to stay distinguishable when it happens four times —
 * a list of four rows all called "Summer sale (copy)" is the same problem the copy was
 * meant to solve.
 *
 * Numbering starts at 2 rather than 1, because the first copy is "(copy)" and the one
 * after it is the second copy. "(copy 1)" would imply an earlier "(copy 0)".
 */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = stripCopySuffix(name);

  const first = `${base} (copy)`;
  if (!used.has(first)) return first;

  // No upper bound to stop at: the loop terminates because `used` is finite, and
  // refusing to duplicate at some arbitrary count would be a worse answer than a long
  // name. `n` is the count of copies, so it starts at the second one.
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (copy ${n})`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * A copy of a copy is still a copy of the original.
 *
 * Without this, duplicating twice down a chain produces "Summer sale (copy) (copy)" and
 * then "(copy) (copy) (copy)" — the name grows a suffix per generation while saying less
 * with each one. Stripping it means the second generation is "(copy 2)", which is both
 * shorter and true.
 */
function stripCopySuffix(name: string): string {
  return name.replace(/ \(copy(?: \d+)?\)$/, "");
}
