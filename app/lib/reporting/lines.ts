/**
 * Splits pasted text into lines without holding a second copy of the whole file.
 *
 * A generator rather than `text.split("\n")` because the importers are written to stream:
 * splitting would double the memory for a 500K-row paste at exactly the moment it is
 * already large. Shared by both importers so they cannot drift on how a line ends.
 */
export async function* linesOf(text: string): AsyncGenerator<string> {
  let start = 0;
  for (;;) {
    const next = text.indexOf("\n", start);
    if (next === -1) break;
    // Trailing carriage return, because a spreadsheet saved on Windows ends every line
    // with one and it would otherwise become part of the last column's value.
    yield text.slice(start, next).replace(/\r$/, "");
    start = next + 1;
  }
  if (start < text.length) yield text.slice(start);
}
