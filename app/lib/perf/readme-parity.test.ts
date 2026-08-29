/**
 * The perf table people read and the baseline the script compares against say the same
 * thing.
 *
 * `measure:admin` now compares its timings to `perf-baseline-admin.json`, which closes the
 * gap that let reconciliation sit at 7ms in a document while measuring 1,006ms. It closes
 * one gap and opens another: the numbers a person actually reads are in a markdown table,
 * hand-copied from that file. Two copies, and only one of them has a script keeping it
 * honest.
 *
 * That is the same drift one step along, and this repo has been bitten by it repeatedly —
 * an alert linked to a runbook page about a different incident, an on-call summary naming
 * two of six pages, a comment describing an index the code could not use.
 *
 * ## Not exact equality
 *
 * A re-record moving a p50 from 27ms to 28ms should not fail a build until somebody edits
 * prose. What must fail is the table being *stale* — materially different from what the
 * script measured. So the same rule the drift check uses decides it: proportionally large
 * and absolutely noticeable, both. 7ms against 1,006ms clears it by two orders of
 * magnitude; 27 against 28 is not a disagreement.
 */

import { describe, expect, it } from "vitest";

import { rawSource } from "../testing/source";
import { compare, type PerfBaseline, type Timing } from "./drift";

const baseline = JSON.parse(
  rawSource("docs", "perf", "perf-baseline-admin.json"),
) as PerfBaseline;

/**
 * The admin table's rows, from the markdown.
 *
 * Read raw rather than through `sourceOf`: this is markdown, where the prose *is* the
 * subject. Only the section under its own heading, so a number in another table cannot
 * satisfy the check for this one.
 */
function tableRows(): Timing[] {
  const readme = rawSource("docs", "perf", "README.md");
  const start = readme.indexOf("## Admin queries");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));

  return [...section.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+) ms\s*\|\s*(\d+) ms\s*\|/gm)].map(
    (row) => ({ label: row[1], p50: Number(row[2]), max: Number(row[3]) }),
  );
}

/** Table headings to baseline labels. The table titles a row for a reader, not a script. */
const HEADING_TO_LABEL: Record<string, string> = {
  "Catalogue, first page": "catalogue, first page",
  "Catalogue, last page (offset 101,100)": "catalogue, last page",
  "Catalogue, text search": "catalogue, text search",
  "Reconciliation, first page": "reconciliation, first page",
  "Reconciliation, deep page": "reconciliation, deep page",
};

describe("the perf README and the recorded baseline", () => {
  const rows = tableRows();

  it("finds the table it is protecting", () => {
    // A floor, so this cannot pass by parsing nothing.
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(baseline.timings.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every row in the table a row in the baseline", () => {
    const recorded = new Set(baseline.timings.map((timing) => timing.label));
    const orphans = rows
      .map((row) => HEADING_TO_LABEL[row.label])
      .filter((label) => !label || !recorded.has(label));

    expect(orphans, "a table row nothing measures cannot go stale visibly").toEqual([]);
  });

  it("gives every measured query a row in the table", () => {
    // The other direction. A query measured and never published is a number nobody sees
    // move — which is how reconciliation's regression stayed invisible for days.
    const published = new Set(rows.map((row) => HEADING_TO_LABEL[row.label]));
    const unpublished = baseline.timings
      .map((timing) => timing.label)
      .filter((label) => !published.has(label));

    expect(unpublished, "measured but absent from the table people read").toEqual([]);
  });

  it("quotes numbers that have not gone stale", () => {
    const quoted: Timing[] = rows.map((row) => ({ ...row, label: HEADING_TO_LABEL[row.label] }));
    const drifted = compare(baseline.timings, quoted)
      .filter((c) => c.movement === "regressed" || c.movement === "improved")
      .map((c) => `${c.label}: baseline ${c.before}ms, README says ${c.after}ms`);

    expect(
      drifted,
      "the table and the measurement disagree — a stale perf number is the one somebody quotes",
    ).toEqual([]);
  });

  it("says which store and how many variants the numbers came from", () => {
    // Timings without a subject are not comparable to anything, and the heading claims a
    // catalogue size that has to be the one measured.
    expect(baseline.shop.length).toBeGreaterThan(0);
    expect(baseline.variants).toBeGreaterThan(0);

    // The *heading*, not the file. "102,132" appears in the intro too, so searching the
    // whole document passes on a different occurrence — a check satisfied by the wrong
    // instance is the shape that has slipped through here before.
    const readme = rawSource("docs", "perf", "README.md");
    const heading = /^## Admin queries.*$/m.exec(readme)?.[0] ?? "";

    expect(heading, "the admin table has no heading to carry a catalogue size").not.toBe("");
    expect(
      heading,
      "the table's heading claims a catalogue size the baseline did not measure",
    ).toContain(baseline.variants.toLocaleString("en-US"));
  });
});
