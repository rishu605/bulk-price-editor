/**
 * The serialiser behind every CSV the app hands a merchant.
 *
 * Eight callers share it — rollback, ledger, activity, reconciliation, preview, baselines,
 * and the two import-error reports — and nothing tested it. A quoting bug would corrupt all
 * eight at once, on exactly the data the file's own comment says it exists for: product
 * titles containing commas and inches, `Monitor, 24"`.
 *
 * The formula cases are the other half. A cell beginning `=`, `+`, `-` or `@` is evaluated
 * by Excel and Sheets when the file opens, and quoting does not prevent it — `"=1+1"` is
 * still parsed as a formula. These cells carry product titles, SKUs and vendor names, all
 * of which arrive from Shopify, which accepts them from suppliers, feeds and other apps. A
 * merchant need not have authored a hostile title for one to reach their catalogue, and the
 * report they open afterwards is about their own store, so nothing about the moment looks
 * untrusted.
 */

import { describe, expect, it } from "vitest";

import { csvCell, filenameSlug, toCsv } from "./csv";

describe("quoting a cell", () => {
  it("quotes every cell, not only the ones that look like they need it", () => {
    expect(csvCell("plain")).toBe('"plain"');
  });

  it("survives the comma and the inch mark a product title routinely has", () => {
    expect(csvCell('Monitor, 24"')).toBe('"Monitor, 24"""');
  });

  it("doubles every internal quote, not just the first", () => {
    expect(csvCell('a"b"c')).toBe('"a""b""c"');
  });

  it("keeps a newline inside the quotes, where a reader can parse it", () => {
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("handles an empty cell", () => {
    expect(csvCell("")).toBe('""');
  });
});

describe("cells a spreadsheet would execute", () => {
  it.each([
    ["=1+1", "an equals formula"],
    ["=HYPERLINK(\"http://example.test\",\"click\")", "a hyperlink"],
    ["@SUM(A1:A9)", "an at-sign formula"],
    ["+1+1", "a plus formula"],
    ["-2+3+cmd|' /C calc'!A0", "the classic command payload"],
    ["\tstarts with a tab", "a tab, which carries into the next cell"],
    ["\rstarts with a return", "a carriage return"],
  ])("neutralises %j — %s", (value) => {
    // An apostrophe is what a spreadsheet reads as "this is text". It is not displayed.
    expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
  });

  it("leaves a negative number alone, so a delta column still sums", () => {
    // The naive fix prefixes every leading `-`, which turns a price-delta column into
    // text. Several of these reports carry deltas, so that cost would be paid on every
    // export to neutralise something that was never a formula.
    expect(csvCell("-1234")).toBe('"-1234"');
    expect(csvCell("-0.5")).toBe('"-0.5"');
  });

  it("leaves an ordinary number alone", () => {
    expect(csvCell("1234")).toBe('"1234"');
    expect(csvCell("12.50")).toBe('"12.50"');
  });

  it("tells a negative number from a payload that starts like one", () => {
    // The whole reason the number test is anchored at both ends. Matching only the
    // leading character cannot distinguish these two.
    expect(csvCell("-1234")).not.toContain("'");
    expect(csvCell("-1234+cmd")).toContain("'");
  });

  it("does not neutralise a formula character anywhere but the front", () => {
    // `a=b` is not a formula, and prefixing it would corrupt an ordinary title.
    expect(csvCell("Size=Large")).toBe('"Size=Large"');
    expect(csvCell("A-Line Skirt")).toBe('"A-Line Skirt"');
  });
});

describe("rendering a file", () => {
  it("puts the header first and every row after it", () => {
    expect(toCsv(["a", "b"], [["1", "2"], ["3", "4"]])).toBe('"a","b"\n"1","2"\n"3","4"\n');
  });

  it("ends with a newline, so appending or concatenating cannot join two rows", () => {
    expect(toCsv(["a"], [["1"]]).endsWith("\n")).toBe(true);
  });

  it("writes a header-only file when there is nothing to report", () => {
    // An empty export is a legitimate answer — no drift, no failures — and a file with
    // no header is one a merchant cannot tell apart from a broken download.
    expect(toCsv(["a", "b"], [])).toBe('"a","b"\n');
  });

  it("neutralises inside rows, not only in isolation", () => {
    // The guard has to be reached by the path the callers actually use. A `csvCell` that
    // neutralises while `toCsv` bypasses it would pass every test above and ship the bug.
    expect(toCsv(["title"], [["=1+1"]])).toContain(`"'=1+1"`);
  });

  it("keeps a comma inside a cell from becoming a column break", () => {
    const csv = toCsv(["title", "sku"], [["Monitor, 24 inch", "M-24"]]);

    expect(csv.split("\n")[1]).toBe('"Monitor, 24 inch","M-24"');
  });
});

describe("naming the downloaded file", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(filenameSlug("Summer Sale 2026")).toBe("summer-sale-2026");
  });

  it("collapses a run of punctuation into one hyphen", () => {
    expect(filenameSlug("Back --- to // School")).toBe("back-to-school");
  });

  it("trims hyphens from both ends", () => {
    expect(filenameSlug("  !Spring!  ")).toBe("spring");
  });

  it("drops characters a filesystem would object to", () => {
    // A campaign name is merchant input and reaches a downloads folder. Path separators
    // and the rest have no business surviving that trip.
    expect(filenameSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(filenameSlug('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("gives an empty string for a name with nothing usable in it", () => {
    // The caller adds its own prefix and extension, so an empty slug is a plain filename
    // rather than a broken one.
    expect(filenameSlug("!!!")).toBe("");
  });
});
