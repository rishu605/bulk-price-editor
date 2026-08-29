/**
 * Noticing that a recorded perf number stopped being true.
 *
 * `docs/perf/README.md` said reconciliation took 7ms. It took 1,006ms, and had done for
 * days, and it was found by accident while measuring something else. Nothing compared the
 * two, so a document recorded a number and then had no further relationship with reality.
 *
 * The failure mode of a check like this is reporting "held" for something it never
 * compared — which is why the empty case, the renamed case and the one-sided cases all have
 * assertions here rather than being left to the happy path.
 */

import { describe, expect, it } from "vitest";

import {
  comparable,
  compare,
  passed,
  REGRESSION_FLOOR_MS,
  REGRESSION_RATIO,
  verdict,
  type Timing,
} from "./drift";

const at = (label: string, p50: number): Timing => ({ label, p50, max: p50 + 5 });

const movementOf = (label: string, before: number, after: number) =>
  compare([at(label, before)], [at(label, after)])[0].movement;

describe("what counts as a regression", () => {
  it("catches the one that actually happened", () => {
    // 7ms to 1,006ms, undetected for days.
    expect(movementOf("reconciliation, first page", 7, 1006)).toBe("regressed");
  });

  it("ignores a fast query wobbling, however large the ratio", () => {
    // 5ms to 12ms is 2.4x and means nothing — timer granularity, a cold cache, an
    // autovacuum passing through. Crying wolf here is how a check stops being read.
    expect(movementOf("catalogue, first page", 5, 12)).toBe("held");
  });

  it("catches a slow query getting slower, on a ratio that looks mild", () => {
    // 1.75x, which a ratio-only rule set higher would miss and an absolute-only rule
    // would drown in noise from the fast queries.
    expect(movementOf("catalogue, last page", 400, 700)).toBe("regressed");
  });

  it("needs both tests, not either", () => {
    // Proportionally large, absolutely tiny.
    expect(movementOf("q", 2, 20)).toBe("held");
    // Absolutely large, proportionally tiny.
    expect(movementOf("q", 1000, 1030)).toBe("held");
  });

  it("does not fire at exactly the thresholds", () => {
    const before = 100;
    const after = Math.max(before * REGRESSION_RATIO, before + REGRESSION_FLOOR_MS);

    expect(movementOf("q", before, after - 1)).toBe("held");
    expect(movementOf("q", before, after)).toBe("regressed");
  });

  it("reports a real improvement, so somebody re-records it", () => {
    // A query that got faster and was never re-recorded leaves the next comparison
    // measuring against a number the app has already beaten — so a later regression back
    // to the old figure reads as "held".
    expect(movementOf("reconciliation, first page", 1006, 59)).toBe("improved");
  });
});

describe("queries on only one side", () => {
  it("names one that is measured but not on record", () => {
    const [only] = compare([], [at("barcode contains", 2)]);

    expect(only.movement).toBe("new");
    expect(only.after).toBe(2);
  });

  it("names one that is on record but no longer measured", () => {
    // A rename would otherwise drop a query's history silently: the old label keeps a
    // number nobody compares again, and the new one starts with no baseline — so a
    // regression can hide inside a rename.
    const [only] = compare([at("reconciliation, deep page", 5)], []);

    expect(only.movement).toBe("missing");
    expect(only.before).toBe(5);
  });

  it("reports both sides of a rename", () => {
    const movements = compare([at("old name", 10)], [at("new name", 900)]).map((c) => c.movement);

    expect(new Set(movements)).toEqual(new Set(["missing", "new"]));
  });
});

describe("the verdict", () => {
  const held = [at("a", 10), at("b", 300)];

  it("passes when nothing regressed", () => {
    expect(verdict(compare(held, held))[0]).toMatch(/^PASS/);
  });

  it("fails on a regression, naming the query and both numbers", () => {
    const line = verdict(compare([at("reconciliation, first page", 7)], [at("reconciliation, first page", 1006)]))[0];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("reconciliation, first page");
    expect(line).toContain("7ms");
    expect(line).toContain("1006ms");
  });

  it("fails when it compared nothing at all", () => {
    // The failure this file exists for. An empty list contains no regression, and would
    // otherwise print a pass for an observation never made.
    const line = verdict([])[0];

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("compared nothing");
  });

  it("warns about a missing query without failing over it", () => {
    // Deleting a page legitimately deletes its measurement. Silence would hide a rename;
    // failing would make removing a feature a perf failure.
    const lines = verdict(compare([at("gone", 5)], [at("a", 10)]));

    expect(lines.some((line) => line.startsWith("WARN"))).toBe(true);
    expect(passed(lines)).toBe(true);
  });

  it("mentions an improvement so it gets re-recorded", () => {
    expect(verdict(compare([at("a", 1000)], [at("a", 50)])).join(" ")).toContain("--record");
  });
});

describe("whether two runs are comparable", () => {
  const base = { shop: "anchor-perf.myshopify.com", variants: 102_132 };

  it("accepts the same store at the same size", () => {
    expect(comparable(base, base)).toBeNull();
  });

  it("refuses a different store", () => {
    // Numbers from another store are a different measurement wearing the same labels.
    const other = comparable(base, { ...base, shop: "boltify-apps.myshopify.com" });

    expect(other).toContain("boltify-apps");
  });

  it("refuses the same store after the catalogue changed size", () => {
    expect(comparable(base, { ...base, variants: 200_000 })).toContain("200000");
  });

  it("tolerates the catalogue drifting slightly, as a live store does", () => {
    // A merchant adding a few products must not invalidate the baseline — the first
    // false alarm is what teaches somebody to pass --record without reading.
    expect(comparable(base, { ...base, variants: 102_132 + 4_000 })).toBeNull();
  });

  it("does not divide by zero on an empty catalogue", () => {
    expect(comparable({ shop: "a", variants: 0 }, { shop: "a", variants: 0 })).toBeNull();
  });
});
