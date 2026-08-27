/**
 * One sync writes one audit entry per market it finds, so the dashboard's five most
 * recent entries were routinely five copies of the same event — five rows spent saying
 * one thing, and five rows not spent on the four other things that happened.
 */

import { describe, expect, it } from "vitest";

import { collapseRuns } from "./collapse";

const entry = (id: string, action: string, actor: string | null, at: string) => ({
  id,
  action,
  actor,
  at,
});

describe("collapsing a run of repeats", () => {
  it("folds consecutive identical actions into one row with a count", () => {
    const runs = collapseRuns([
      entry("1", "market.added", null, "2026-08-27T12:40:38.000Z"),
      entry("2", "market.added", null, "2026-08-27T12:40:37.000Z"),
      entry("3", "market.added", null, "2026-08-27T12:40:36.000Z"),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(3);
  });

  it("keeps the newest entry of the run, because that is the timestamp worth showing", () => {
    const runs = collapseRuns([
      entry("newest", "market.added", null, "2026-08-27T12:40:38.000Z"),
      entry("older", "market.added", null, "2026-08-27T12:40:37.000Z"),
    ]);

    expect(runs[0].entry.id).toBe("newest");
  });

  it("does not fold across a different actor", () => {
    // Same event, different accountability. The audit log exists for the accountability.
    const runs = collapseRuns([
      entry("1", "market.added", "staff:1", "2026-08-27T12:00:00.000Z"),
      entry("2", "market.added", null, "2026-08-27T11:00:00.000Z"),
    ]);

    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.count === 1)).toBe(true);
  });

  it("only folds neighbours, so a folded row is still a true stretch of history", () => {
    // Grouping by action across the whole list would reorder events and imply an
    // adjacency that was not there.
    const runs = collapseRuns([
      entry("1", "market.added", null, "2026-08-27T12:00:00.000Z"),
      entry("2", "drift.accepted", null, "2026-08-27T11:00:00.000Z"),
      entry("3", "market.added", null, "2026-08-27T10:00:00.000Z"),
    ]);

    expect(runs.map((run) => run.entry.id)).toEqual(["1", "2", "3"]);
    expect(runs.map((run) => run.count)).toEqual([1, 1, 1]);
  });

  it("has nothing to say about an empty log", () => {
    expect(collapseRuns([])).toEqual([]);
  });
});
