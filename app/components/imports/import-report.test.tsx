/**
 * The import report accounts for the whole file (#766).
 *
 * "Need attention" showed the length of the problem lists, and each list stops at 500.
 * A file with 800 bad rows read 1,000 / 200 / 500 -- counts that do not add up, with
 * nothing saying the table was cut short. Rendered to markup, as the page shell's tests
 * render theirs: these are custom elements, and the words are what is being asserted.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";
import { ImportReport, type ImportProblem } from "./ImportForm";

const problem = (line: number): ImportProblem => ({
  line,
  identifier: `SKU-${line}`,
  reason: "No variant in this shop has that SKU, barcode or ID.",
  kind: "No match",
});

const report = (problems: ImportProblem[], problemCount?: number) =>
  renderToStaticMarkup(
    <ImportReport
      heading="What would happen"
      counts={[
        { label: "Rows read", value: 1_000 },
        { label: "Ready", value: 200 },
        { label: "Need attention", value: problemCount ?? problems.length },
      ]}
      problems={problems}
      problemCount={problemCount}
    />,
  );

describe("a report whose problems were listed only in part", () => {
  const listed = Array.from({ length: 500 }, (_, i) => problem(i + 2));

  it("says how many it lists of how many there are", () => {
    expect(report(listed, 800)).toContain("Showing the first 500 of 800 rows that need attention.");
  });

  it("groups a large count, as the tiles above it do (#759)", () => {
    expect(report(listed, 12_400)).toContain("Showing the first 500 of 12,400 rows that need attention.");
  });

  it("says nothing of the kind when every problem is listed", () => {
    expect(report(listed, 500)).not.toContain("rows that need attention");
    expect(report(listed)).not.toContain("rows that need attention");
  });

  it("never reports a clean file while rows still need attention", () => {
    // None listed, some counted: "every row matched" would be a lie about the file.
    expect(report([], 3)).not.toContain("Every row matched a variant and validated");
    expect(report([])).toContain("Every row matched a variant and validated");
  });
});

describe("the spreadsheet campaign's report", () => {
  const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
  const SERVICE = sourceOf("app/services/price-import.server.ts");

  it("counts Need attention from the importer, not from the lists it was sent", () => {
    expect(EDITOR).toContain('{ label: "Need attention", value: importResult.problems }');
    expect(EDITOR).toContain("problemCount={importResult.problems}");
    expect(EDITOR).not.toContain('{ label: "Need attention", value: importProblems.length }');
  });

  it("counts every problem the importer meets, listed or not", () => {
    // `push` is the capped list; every row that needs attention goes through `problem`,
    // which counts it first. A bare `push(result.` would be a row the count never saw.
    expect(SERVICE).toContain("result.problems++;");
    expect(SERVICE).not.toMatch(/\bpush\(result\./);
  });
});

describe("import leftovers (#989)", () => {
  const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
  const BASELINES = sourceOf("app/routes/app.prices.baselines._index.tsx");
  const BASELINE_SERVICE = sourceOf("app/services/baseline-import.server.ts");

  it("offers the rows it lists, and says 'all' only when they are all", () => {
    const listed = Array.from({ length: 500 }, (_, i) => problem(i + 2));
    const withDownload = (problemCount: number) =>
      renderToStaticMarkup(
        <ImportReport
          heading="What would happen"
          counts={[]}
          problems={listed}
          problemCount={problemCount}
          download={{ filename: "x.csv", csv: () => "" }}
        />,
      );
    expect(withDownload(800)).toContain("Download the first 500 (CSV)");
    expect(withDownload(800)).not.toContain("Download all 500");
    expect(withDownload(500)).toContain("Download all 500 (CSV)");
  });

  it("gives the file path one name field, the one its form posts", () => {
    expect(EDITOR).toMatch(/fromFile \? null : \(\s*<FullRow>\s*<CampaignNameField/);
    expect(EDITOR).toContain('<s-text-field name="name" label="Campaign name" value={defaultName} />');
    expect(EDITOR).not.toContain('label="Call this"');
  });

  it("commits with the key its check answered with, and offers the problems as a file", () => {
    // Through the shared form's field since #1059, which every importer renders.
    expect(EDITOR).toContain("checkKey={importFetcher.data?.checkKey}");
    expect(EDITOR).toContain("csv: () => importErrorCsv(importResult)");
  });

  it("counts the baseline import's problems past its cap", () => {
    expect(BASELINES).toContain('{ label: "Need attention", value: result.problems }');
    expect(BASELINES).toContain("problemCount={result.problems}");
    expect(BASELINE_SERVICE).toContain("result.problems++;");
    expect(BASELINE_SERVICE).not.toMatch(/\brecord\(result\./);
  });
});
