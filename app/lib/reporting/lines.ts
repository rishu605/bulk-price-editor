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
  // A record, not a physical line (#738): a newline inside a quoted value is part of the
  // value. A Shopify or Matrixify export's Body HTML holds them, and splitting there turned
  // one product into two rows that each failed for "no SKU" -- the real row lost, and the
  // reason pointing at the wrong thing.
  const state: QuoteState = { quoted: false, fieldStart: true };
  let start = 0;
  let from = 0;
  let spans = 1;
  for (;;) {
    const next = text.indexOf("\n", from);
    if (next === -1) break;
    scan(text, from, next, state);
    from = next + 1;
    if (state.quoted) {
      spans++;
      continue;
    }
    // Trailing carriage return, because a spreadsheet saved on Windows ends every line
    // with one and it would otherwise become part of the last column's value.
    yield stripCarriageReturn(text.slice(start, next));
    // One blank line for each newline the record held, so every later row keeps the line
    // number the merchant's spreadsheet gives it: the readers count blank lines and skip them.
    for (; spans > 1; spans--) yield "";
    start = from;
    state.fieldStart = true;
  }
  if (start >= text.length) return;
  scan(text, from, text.length, state);
  // A quote never closed is not a value spanning the rest of the file: read what is left
  // line by line, as every line was read before. The rows it spoils fail by their own line.
  if (state.quoted) {
    yield* physicalLines(text.slice(start));
    return;
  }
  // The same strip on the final line, which was missing. A paste ending `...\r` with no
  // closing newline kept the carriage return on its last column -- so a cost of "12.50\r"
  // failed to parse and the row came back "invalid" for a reason the merchant could not
  // see in their spreadsheet. Two branches yielding lines had to agree on what a line is.
  yield stripCarriageReturn(text.slice(start));
}

interface QuoteState {
  /** Inside a quoted value, where a newline or a comma is part of the value. */
  quoted: boolean;
  /** At the start of a field, the one place a quote opens a quoted value (RFC 4180). */
  fieldStart: boolean;
}

/**
 * Carries the quote state across `text[from, to)`, as `splitCsvLine` reads a record: a quote
 * opens a value only where a field starts, a doubled quote inside one is a quote, and any
 * other quote inside one closes it. A quote mid-field -- `27" monitor` -- is a character.
 */
function scan(text: string, from: number, to: number, state: QuoteState): void {
  // Most lines hold no quote, and outside a quoted value such a line cannot open one. Where
  // its fields start does not matter: the newline after it ends the record.
  if (!state.quoted) {
    const quote = text.indexOf('"', from);
    if (quote === -1 || quote >= to) return;
  }
  for (let i = from; i < to; i++) {
    const char = text[i];
    if (state.quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') i++;
        else state.quoted = false;
      }
      continue;
    }
    if (char === '"' && state.fieldStart) {
      state.quoted = true;
      state.fieldStart = false;
    } else if (char === ",") state.fieldStart = true;
    else if (char !== " " && char !== "\t") state.fieldStart = false;
  }
}

function* physicalLines(text: string): Generator<string> {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) yield stripCarriageReturn(line);
}
