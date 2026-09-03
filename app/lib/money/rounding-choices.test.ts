/**
 * A select option a merchant can read once it is chosen.
 *
 * A native select shows every option in full while the list is open, and only as much of
 * the chosen one as the closed control is wide. So option text is not a typography
 * question — it decides whether the merchant can see which rounding they picked without
 * opening the list again.
 *
 * The campaign editor is where this bit. Its form column is about 470px, and its field
 * grid halves that, so a select gets roughly 220px — about twenty-eight characters. The
 * options read `Leave prices exactly as calculated · $2,347.62 → $2,347.62`, fifty-eight
 * of them, and arrived as "Leave prices exactly as calc…".
 *
 * The fix was to stop repeating the starting price in all six. It is identical in every
 * option, so it is said once in the select's `details` and each option shows only what it
 * does to it. What that preserves is the reason the examples are in the options at all:
 * six explaining themselves while the merchant compares them, rather than one line
 * describing whichever is already chosen.
 *
 * These budgets are characters because that is what the source can count. They are not a
 * substitute for looking at the page — the whole ticket exists because nobody had.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { roundingChoices, sampleLine } from "./rounding-example";

/**
 * What fits in a select given a full row of the campaign editor's form column.
 *
 * ~470px, less the chevron and the control's own padding, at the admin's body size.
 * Deliberately not the 220px of a half row: the editor puts this select in a `FullRow`
 * precisely because these six are the longest text in the form.
 */
const FULL_ROW = 50;

/** The same select on a half row, which every other option list in the editor gets. */
const HALF_ROW = 28;

const CURRENCIES = ["USD", "JPY"];

describe("rounding options fit the control that shows them", () => {
  it.each(CURRENCIES)("%s", (currency) => {
    const tooLong = roundingChoices(currency)
      .map((choice) => `${choice.label} · ${choice.example}`)
      .filter((line) => line.length > FULL_ROW);

    expect(
      tooLong,
      "a chosen option longer than the closed select is one the merchant cannot read back",
    ).toEqual([]);
  });

  it("does not repeat the starting price in every option", () => {
    // The starting price is the same in all six. Repeating it is what made the longest
    // option twice as long as the control, and it is the first thing that would come
    // back if somebody reinstated the "before becomes after" sentence.
    const lines = roundingChoices("USD").map((choice) => choice.example);
    const sample = sampleLine("USD");

    for (const line of lines) {
      expect(sample).toContain("$2,347.62");
      expect(line, `"${line}" restates the starting price`).not.toContain(" → ");
      expect(line).not.toContain(" becomes ");
    }
  });

  it("says once what the examples start from", () => {
    // Without this the options are bare numbers with no question attached.
    expect(sampleLine("USD")).toContain("$2,347.62");
    expect(sampleLine("JPY")).toContain("¥234,762");
  });
});

describe("the pages that show them", () => {
  const editor = sourceOf(process.cwd(), "app", "routes", "app.campaigns.new.tsx");
  const settings = sourceOf(process.cwd(), "app", "routes", "app.settings._index.tsx");

  it("both name the sample beside the select", () => {
    expect(editor).toContain("sample");
    expect(settings).toContain("details={sample}");
  });

  it("the editor gives the rounding select a whole row", () => {
    // Half a row is 28 characters and the longest option is well past that, so this is
    // the difference between the fix working and not.
    const select = editor.indexOf('name="rounding.default"');
    const fullRow = editor.lastIndexOf("<FullRow>", select);
    const closes = editor.lastIndexOf("</FullRow>", select);

    expect(fullRow).toBeGreaterThan(-1);
    expect(fullRow, "the rounding select is not inside the FullRow").toBeGreaterThan(closes);
  });

  it("keeps the compare-at options short enough for a half row", () => {
    // "Set to baseline (shows a strike-through)" was forty characters in a
    // twenty-eight character control; what it *does* is a note, and notes go in details.
    const block = editor.slice(
      editor.indexOf('name="compareAt"'),
      editor.indexOf("</s-select>", editor.indexOf('name="compareAt"')),
    );

    const options = [...block.matchAll(/<s-option[^>]*>([\s\S]*?)<\/s-option>/g)].map((match) =>
      match[1].replace(/\s+/g, " ").trim(),
    );

    expect(options.length).toBeGreaterThanOrEqual(3);
    for (const option of options) {
      expect(option.length, `"${option}" will be cut off in a half-row select`).toBeLessThanOrEqual(
        HALF_ROW,
      );
    }
  });
});
