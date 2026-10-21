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
export function copyName(name: string, taken: readonly string[], label: CopyLabel = "copy"): string {
  const used = new Set(taken);
  const base = stripCopySuffix(name, label);

  const first = `${base} (${label})`;
  if (!used.has(first)) return first;

  // No upper bound to stop at: the loop terminates because `used` is finite, and
  // refusing to duplicate at some arbitrary count would be a worse answer than a long
  // name. `n` is the count of copies, so it starts at the second one.
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${label} ${n})`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * What the suffix calls the copy. "real" for a practice campaign's real copy (#1077): in the
 * list beside its source, the one that can be applied is the one a merchant looks for.
 */
export type CopyLabel = "copy" | "real";

/**
 * A copy of a copy is still a copy of the original.
 *
 * Without this, duplicating twice down a chain produces "Summer sale (copy) (copy)" and
 * then "(copy) (copy) (copy)" — the name grows a suffix per generation while saying less
 * with each one. Stripping it means the second generation is "(copy 2)", which is both
 * shorter and true. Only this copy's own suffix: a real copy of "Sale (copy)" is a real copy
 * of that duplicate, and says so.
 */
function stripCopySuffix(name: string, label: CopyLabel): string {
  return name.replace(new RegExp(` \\(${label}(?: \\d+)?\\)$`), "");
}
