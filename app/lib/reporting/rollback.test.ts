/**
 * Row classification and the export.
 *
 * The classification decides whether a revert asks a person a question. Getting it
 * wrong in one direction silently overwrites a deliberate edit; in the other it fills
 * the report with questions about rows nobody touched, which trains people to click
 * through it — and then the rows that mattered go with them.
 */

import { describe, expect, it } from "vitest";

import {
  classifyRollbackRow,
  rollbackReportCsv,
  type RollbackReport,
} from "./rollback";

describe("classifyRollbackRow", () => {
  it("calls a row clean when live matches what we applied", () => {
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: 8_000 })).toBe("clean");
  });

  it("calls a row drifted when somebody changed it since", () => {
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: 7_500 })).toBe("drifted");
  });

  it("reports a deleted variant as deleted rather than drifted", () => {
    // A merchant removing a product mid-sale is ordinary. Surfacing it as a conflict
    // needing resolution would be asking a question with no answer (E4).
    expect(classifyRollbackRow({ deleted: true, applied: 8_000, live: null })).toBe("deleted");
  });

  it("prefers deleted over drifted when both look true", () => {
    expect(classifyRollbackRow({ deleted: true, applied: 8_000, live: 7_500 })).toBe("deleted");
  });

  it("treats an unknown comparison as clean, not as a question", () => {
    // No mirrored live value, or nothing recorded as applied. There is no evidence of
    // an edit, and inventing one costs the merchant attention they will stop paying.
    expect(classifyRollbackRow({ deleted: false, applied: null, live: 8_000 })).toBe("clean");
    expect(classifyRollbackRow({ deleted: false, applied: 8_000, live: null })).toBe("clean");
  });
});

describe("rollbackReportCsv", () => {
  const report = (rows: RollbackReport["rows"]): RollbackReport => ({
    campaignId: "c1",
    campaignName: "Summer sale",
    rows,
    counts: { total: rows.length, clean: 0, drifted: 0, deleted: 0 },
    straightforward: false,
  });

  it("writes a header and one row per variant", () => {
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/1",
          title: "Blue shirt",
          kind: "drifted",
          applied: "$80.00",
          live: "$75.00",
          revertsTo: "$100.00",
        },
      ]),
    );

    const lines = csv.trim().split("\n");
    // Header quoted like every other cell. Uniform quoting means there is no cell
    // whose safety depends on someone having checked it could not contain a comma.
    expect(lines[0]).toBe(
      '"variant_gid","title","state","applied","live_now","reverts_to"',
    );
    expect(lines[1]).toBe(
      '"gid://Variant/1","Blue shirt","drifted","$80.00","$75.00","$100.00"',
    );
  });

  it("survives titles containing commas and quotes", () => {
    // Product titles carry both routinely — a 24" monitor, "Red, large". A report that
    // corrupts itself on ordinary catalogue data is not a record of anything.
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/2",
          title: 'Monitor, 24" — "Pro"',
          kind: "clean",
          applied: "$80.00",
          live: "$80.00",
          revertsTo: "$100.00",
        },
      ]),
    );

    expect(csv).toContain('"Monitor, 24"" — ""Pro"""');
    expect(csv.trim().split("\n")).toHaveLength(2);
  });

  it("writes empty cells rather than the word null", () => {
    const csv = rollbackReportCsv(
      report([
        {
          variantGid: "gid://Variant/3",
          title: "Gone",
          kind: "deleted",
          applied: "$80.00",
          live: null,
          revertsTo: null,
        },
      ]),
    );

    expect(csv).toContain('"gid://Variant/3","Gone","deleted","$80.00","",""');
    expect(csv).not.toContain("null");
  });
});
