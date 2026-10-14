import { describe, expect, it } from "vitest";

import { commitReady, rowsOf } from "./checked-rows";

const FILE = "Variant SKU,Variant Price\nCH-1,129.00\nCH-2,149.00";

describe("the commit acts on the rows that were checked (#766)", () => {
  it("offers the count while the box holds exactly the rows the check read", () => {
    expect(commitReady(2, FILE, FILE)).toBe(2);
  });

  it("offers nothing once the rows are edited after the check", () => {
    // The reported bug: the button kept the old count and posted the new rows, so a
    // campaign was made from rows nobody had checked.
    expect(commitReady(2, `${FILE}\nCH-3,159.00`, FILE)).toBeNull();
    expect(commitReady(2, FILE.replace("129.00", "12.90"), FILE)).toBeNull();
  });

  it("offers it again once the box is put back to what was checked", () => {
    // The same rows are the same check: nothing about them is unchecked.
    const edited = `${FILE}\nCH-3,159.00`;
    expect(commitReady(2, edited, FILE)).toBeNull();
    expect(commitReady(2, FILE, FILE)).toBe(2);
  });

  it("offers nothing before a check has answered", () => {
    expect(commitReady(null, FILE, FILE)).toBeNull();
  });

  it("offers nothing when the answer on screen is not this form's check", () => {
    // The form mounted again over an answer it did not send -- the editor's spreadsheet
    // option switched away and back -- with an empty box. The answer is about rows that
    // are no longer anywhere.
    expect(commitReady(2, "", null)).toBeNull();
  });

  it("offers nothing before the box has been read", () => {
    expect(commitReady(2, null, FILE)).toBeNull();
  });

  it("passes a check that found nothing through as zero, for the button to refuse", () => {
    // Zero is not null: the button is disabled on `!ready` either way, but the count it
    // names is still the check's.
    expect(commitReady(0, FILE, FILE)).toBe(0);
  });
});

describe("the rows a form would post", () => {
  it("are the csv field, as a submit sends it", () => {
    const fields = new FormData();
    fields.set("name", "Sale");
    fields.set("csv", FILE);
    expect(rowsOf(fields)).toBe(FILE);
  });

  it("are empty when the form has no rows at all", () => {
    expect(rowsOf(new FormData())).toBe("");
  });
});
