/**
 * Splitting a pasted file into lines.
 *
 * Both importers share this, so a mistake here is wrong prices or wrong costs on whatever
 * the merchant pasted — and it had no test. Two deliberate breakages passed all 2,948:
 * dropping the carriage-return strip, and dropping the final line when the paste has no
 * trailing newline.
 *
 * Neither is an edge case. A spreadsheet saved on Windows ends every line with `\r`, which
 * unstripped becomes part of the last column's value; and a paste without a trailing
 * newline is what a text box gives you when somebody does not press return at the end.
 * Both fail silently: the import succeeds, the numbers are just wrong.
 */

import { describe, expect, it } from "vitest";

import { linesOf } from "./lines";

const collect = async (text: string): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of linesOf(text)) lines.push(line);
  return lines;
};

describe("splitting a paste into lines", () => {
  it("splits on newlines", async () => {
    expect(await collect("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("keeps the last line when there is no trailing newline", async () => {
    // What a textarea gives you when the merchant does not press return at the end. An
    // import of 500 prices would write 499 and report success.
    expect(await collect("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("strips the carriage return a Windows spreadsheet leaves on every line", async () => {
    // Unstripped, `\r` becomes part of the last column's value — so every price in the
    // file parses as something else, or fails to parse, for a reason nothing names.
    expect(await collect("a,1\r\nb,2\r\n")).toEqual(["a,1", "b,2"]);
  });

  it("strips it from the final line too, newline or not", async () => {
    expect(await collect("a\r\nb\r")).toEqual(["a", "b"]);
  });

  it("strips only the trailing carriage return, not one inside a value", async () => {
    // A quoted CSV field can legitimately contain one. Removing every `\r` would edit
    // the merchant's data rather than the line ending.
    expect(await collect("a\rb\n")).toEqual(["a\rb"]);
  });

  it("yields nothing for empty input", async () => {
    expect(await collect("")).toEqual([]);
  });

  it("keeps blank lines, so the line numbers an error report quotes still match", async () => {
    // The importers count lines to say "line 412". Silently skipping blanks would shift
    // every number after the first one, and the merchant would look at the wrong row.
    expect(await collect("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("handles a file that is one line with no newline at all", async () => {
    expect(await collect("only")).toEqual(["only"]);
  });

  it("does not invent a line after a trailing newline", async () => {
    expect(await collect("a\n")).toEqual(["a"]);
  });

  it("streams rather than materialising the whole split", async () => {
    // The reason it is a generator: splitting a 500K-row paste doubles the memory at
    // exactly the moment it is already large. Taking one line must not require the rest.
    const iterator = linesOf("first\nsecond\nthird\n")[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toBe("first");
  });
});

describe("a quoted value that holds a line break (#738)", () => {
  it("is one record, padded with a blank line per break so later line numbers still match", async () => {
    // A Shopify export's Body HTML. Split at its newline, one product became two rows that
    // each failed for "no SKU", and the real row was lost.
    expect(await collect('A-1,"<p>Soft</p>\n<p>Warm</p>",12.00\nB-2,,9.00\n')).toEqual([
      'A-1,"<p>Soft</p>\n<p>Warm</p>",12.00',
      "",
      "B-2,,9.00",
    ]);
  });

  it("holds a Windows line break inside the value, and strips only the record's own", async () => {
    expect(await collect('A-1,"one\r\ntwo\r\nthree",12.00\r\nB-2,,9.00\r\n')).toEqual([
      'A-1,"one\r\ntwo\r\nthree",12.00',
      "",
      "",
      "B-2,,9.00",
    ]);
  });

  it("reads a doubled quote as a quote, not the end of the value", async () => {
    expect(await collect('A-1,"he said ""hi""\nthen left",1\nB-2,2')).toEqual(['A-1,"he said ""hi""\nthen left",1', "", "B-2,2"]);
  });

  it("takes a quote in the middle of a cell for a character", async () => {
    expect(await collect('27" monitor,1\nB-2,2\n')).toEqual(['27" monitor,1', "B-2,2"]);
    expect(await collect('A-1, "spaced\nvalue",1\n')).toEqual(['A-1, "spaced\nvalue",1', ""]);
  });

  it("reads the rest line by line when a quote is never closed, rather than as one value", async () => {
    // One stray quote must not swallow every row after it.
    expect(await collect('A-1,"open,1\nB-2,2\nC-3,3')).toEqual(['A-1,"open,1', "B-2,2", "C-3,3"]);
    expect(await collect('A-1,1\nB-2,"open\r\nC-3,3\r\n')).toEqual(["A-1,1", 'B-2,"open', "C-3,3"]);
  });
});

