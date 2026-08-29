/**
 * The verdict a restore drill prints.
 *
 * The numbers need a real Postgres and 17 MB of real data; what they *mean* does not. And
 * the meaning is where a drill like this fails silently — by reporting a pass for something
 * it never observed. A restore that says "every critical table came back whole" having
 * compared no tables is worse than no drill at all, because it is the line somebody quotes
 * in the hour they most need it to be true.
 *
 * `docs/runbooks.md` asked for exactly this and had been waiting: *"Rehearse this, do not
 * assume it. The numbers above are objectives until somebody has timed them against a real
 * snapshot."*
 */

import { describe, expect, it } from "vitest";

import {
  CRITICAL_TABLES,
  passed,
  REQUIRED_OBJECTS,
  RTO_BUDGET_MS,
  verdict,
  type RestoreDrill,
} from "./drill-restore";

const whole = CRITICAL_TABLES.map((table) => ({ table, source: 1_000, restored: 1_000 }));

const drill = (over: Partial<RestoreDrill> = {}): RestoreDrill => ({
  dumpMs: 2_100,
  restoreMs: 7_400,
  migrateMs: 700,
  dumpBytes: 17 * 1024 * 1024,
  rows: whole,
  missingExtensions: [],
  missingIndexes: [],
  cleanedUp: true,
  ...over,
});

describe("the RTO budget", () => {
  it("passes a restore inside the hour", () => {
    expect(verdict(drill())[0]).toMatch(/^PASS/);
  });

  it("fails one that runs over, and says by how much", () => {
    const line = verdict(drill({ restoreMs: RTO_BUDGET_MS + 60_000 }))[0];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("61.0 min");
  });

  it("treats exactly the budget as inside it", () => {
    expect(verdict(drill({ dumpMs: RTO_BUDGET_MS, restoreMs: 0, migrateMs: 0 }))[0]).toMatch(/^PASS/);
  });

  it("counts all three phases, not just the restore", () => {
    // Dump and migrate are part of the hour a merchant is down. Timing only the restore
    // would report a comfortable pass for a procedure that misses the objective.
    const line = verdict(drill({ dumpMs: 40 * 60_000, restoreMs: 30 * 60_000, migrateMs: 0 }))[0];

    expect(line).toMatch(/^FAIL/);
  });
});

describe("completeness", () => {
  it("passes when every critical table matches", () => {
    expect(verdict(drill())[1]).toMatch(/^PASS/);
  });

  it("fails when a table came back short, naming it and both counts", () => {
    const line = verdict(
      drill({ rows: [...whole.slice(1), { table: "baselines", source: 1_000, restored: 998 }] }),
    )[1];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("baselines 998 of 1000");
  });

  it("fails when it compared nothing at all", () => {
    // The failure this file exists for. An empty list satisfies "no table came back
    // short" and would otherwise print a pass for an observation never made.
    const line = verdict(drill({ rows: [] }))[1];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("compared no tables");
  });

  it("fails when a table could not be counted in either database", () => {
    // Two unreadable counts are equal, so an equality check alone reads a table missing
    // from *both* copies as matching.
    const line = verdict(
      drill({ rows: [{ table: "variant_changes", source: -1, restored: -1 }] }),
    )[1];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("could not be counted");
  });

  it("covers the ledger and the baselines, which are the two that cannot be rebuilt", () => {
    // The runbook orders the tables by how badly it hurts to lose them. The mirror is
    // rebuildable from Shopify; these two are not, and a drill omitting them would be
    // measuring the recoverable half.
    expect(CRITICAL_TABLES).toContain("baselines");
    expect(CRITICAL_TABLES).toContain("variant_changes");
  });
});

describe("the objects a row count cannot see", () => {
  it("passes when the extensions and indexes are present", () => {
    expect(verdict(drill())[2]).toMatch(/^PASS/);
  });

  it("fails on a missing extension, naming it", () => {
    const line = verdict(drill({ missingExtensions: ["pg_trgm"] }))[2];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("pg_trgm");
  });

  it("fails on a missing index", () => {
    // A restore returning every row and none of the indexes is a working app that
    // searches forty times slower — which reads as a successful restore.
    expect(verdict(drill({ missingIndexes: ["variant_index_sku_trgm"] }))[2]).toMatch(/^FAIL/);
  });

  it("checks the extension the schema gained most recently", () => {
    // pg_trgm arrived in #512. A dump carries CREATE EXTENSION only if the target
    // cluster has it available, and mid-restore is the wrong time to find out.
    expect(REQUIRED_OBJECTS.extensions).toContain("pg_trgm");
  });
});

describe("what the drill admits to", () => {
  it("reports the target database being dropped", () => {
    expect(verdict(drill()).join(" ")).toContain("target database dropped");
  });

  it("warns when it could not drop it", () => {
    const lines = verdict(drill({ cleanedUp: false }));

    expect(lines.some((line) => line.startsWith("WARN"))).toBe(true);
    // A leftover database is not a failed restore. Warning without failing keeps the
    // verdict about the procedure rather than about the housekeeping.
    expect(passed(lines)).toBe(true);
  });

  it("says on every run that RPO was not measured", () => {
    // Three PASS lines would otherwise read as "the objective is met", and half the
    // objective — five minutes of data loss — depends on Railway's backup cadence, which
    // this drill cannot reach. Stated always, not only when something fails.
    expect(verdict(drill()).join(" ")).toContain("RPO NOT MEASURED");
  });

  it("prints the phase breakdown, so a slow restore says which phase was slow", () => {
    expect(verdict(drill()).join(" ")).toMatch(/dump .* restore .* migrate /);
  });
});

describe("passed()", () => {
  it("is true when nothing failed", () => {
    expect(passed(verdict(drill()))).toBe(true);
  });

  it("is false when anything did", () => {
    expect(passed(verdict(drill({ missingExtensions: ["pg_trgm"] })))).toBe(false);
  });
});
