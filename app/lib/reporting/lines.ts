/**
 * Splits pasted text into lines without holding a second copy of the whole file.
 *
 * A generator rather than `text.split("\n")` because the importers are written to stream:
 * splitting would double the memory for a 500K-row paste at exactly the moment it is
 * already large. Shared by both importers so they cannot drift on how a line ends.
 */
/** Only the line ending, never a carriage return inside a quoted value. */
const stripCarriageReturn = (line: string): string => line.replace(/\r$/, "");

export async function* linesOf(text: string): AsyncGenerator<string> {
  let start = 0;
  for (;;) {
    const next = text.indexOf("\n", start);
    if (next === -1) break;
    // Trailing carriage return, because a spreadsheet saved on Windows ends every line
    // with one and it would otherwise become part of the last column's value.
    yield stripCarriageReturn(text.slice(start, next));
    start = next + 1;
  }
  // The same strip on the final line, which was missing. A paste ending `...\r` with no
  // closing newline kept the carriage return on its last column -- so a cost of "12.50\r"
  // failed to parse and the row came back "invalid" for a reason the merchant could not
  // see in their spreadsheet. Two branches yielding lines had to agree on what a line is.
  if (start < text.length) yield stripCarriageReturn(text.slice(start));
}
