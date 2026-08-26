/**
 * The summary a merchant reads after a run.
 *
 * The failure this guards against is a partial run that reads as a success. Every
 * assertion here is about what the sentence says and which rows the margin figure is
 * entitled to include — not about how the counting is implemented.
 */

import { describe, expect, it } from "vitest";

import { describeRun, summariseRun, tallyStatuses, type ResultRow } from "./run-result";

const GBP = "GBP";

let nextId = 0;

function row(status: string, over: Partial<ResultRow> = {}): ResultRow {
  return {
    variantGid: `gid://shopify/ProductVariant/${(nextId += 1)}`,
    title: "A product",
    status,
    // 10.00 → 8.00 on a cost of 5.00: 50% margin becomes 37.5%.
    beforeMinor: 1000n,
    afterMinor: 800n,
    costMinor: 500n,
    currency: GBP,
    ...over,
  } as ResultRow;
}

describe("which rows the margin figure may use", () => {
  it("uses verified rows", () => {
    const result = summariseRun([row("VERIFIED")], null);

    expect(result.margin.covered).toBe(1);
    expect(result.margin.averageBefore).toBeCloseTo(50);
    expect(result.margin.averageAfter).toBeCloseTo(37.5);
  });

  it("uses clamped rows, because a clamped price is what a shopper pays", () => {
    expect(summariseRun([row("CLAMPED")], null).margin.covered).toBe(1);
  });

  it("excludes a row written but not read back", () => {
    // Invariant I5: a row we could not verify is not evidence of a price. Averaging it in
    // would make a partial run look complete.
    const result = summariseRun([row("APPLIED")], null);

    expect(result.margin.covered).toBe(0);
    expect(result.counts.unverified).toBe(1);
  });

  it.each(["FAILED", "SKIPPED", "PENDING", "WRITING"])("excludes a %s row", (status) => {
    expect(summariseRun([row(status)], null).margin.covered).toBe(0);
  });

  it("counts a verified row with no cost as unknown rather than assuming one", () => {
    // A blended margin that invented a cost for the products that have none would be a
    // number that looks precise and is made up.
    const result = summariseRun([row("VERIFIED", { costMinor: null })], null);

    expect(result.margin.covered).toBe(0);
    expect(result.margin.unknown).toBe(1);
  });
});

describe("counting what happened", () => {
  const rows = [
    row("VERIFIED"),
    row("VERIFIED", { title: "Another" }),
    row("CLAMPED"),
    row("APPLIED"),
    row("SKIPPED"),
    row("FAILED"),
    row("REVERTED"),
    row("PENDING"),
  ];

  it("puts every row in exactly one bucket", () => {
    const { counts } = summariseRun(rows, null);
    const bucketed =
      counts.verified +
      counts.unverified +
      counts.clamped +
      counts.skipped +
      counts.failed +
      counts.reverted +
      counts.pending;

    expect(bucketed).toBe(counts.total);
    expect(counts.total).toBe(rows.length);
  });

  it("treats a reverted row as settled, not as still to run", () => {
    // REVERTED is written by the revert path. Counting it as outstanding would report a
    // finished campaign as still going, forever.
    const result = summariseRun([row("VERIFIED"), row("REVERTED")], null);

    expect(result.counts.reverted).toBe(1);
    expect(result.counts.pending).toBe(0);
    expect(result.clean).toBe(true);
  });

  it("keeps a reverted row out of the margin, because its price is gone", () => {
    const result = summariseRun([row("REVERTED")], null);

    expect(result.margin.covered).toBe(0);
    expect(result.margin.unknown).toBe(0);
  });

  it("says how many were reverted since, rather than silently dropping them", () => {
    expect(describeRun(summariseRun([row("VERIFIED"), row("REVERTED")], null)))
      .toContain("1 has been reverted since");
  });

  it("treats an unrecognised status as unfinished, not as done", () => {
    // A status added later must make a run look incomplete rather than clean, or a stuck
    // run reports success.
    const result = summariseRun([row("SOME_NEW_STATUS")], null);

    expect(result.counts.pending).toBe(1);
    expect(result.clean).toBe(false);
  });
});

describe("a run is only clean when nothing is outstanding", () => {
  it("is clean when every row verified", () => {
    expect(summariseRun([row("VERIFIED"), row("SKIPPED")], null).clean).toBe(true);
  });

  it.each(["FAILED", "APPLIED", "PENDING"])("is not clean with a %s row", (status) => {
    expect(summariseRun([row("VERIFIED"), row(status)], null).clean).toBe(false);
  });
});

describe("the sentence a merchant reads", () => {
  it("leads with the failures, not with the successes", () => {
    // A partial run that opens by congratulating itself is the failure mode the whole
    // product exists to avoid.
    const text = describeRun(summariseRun([row("VERIFIED"), row("FAILED")], null));

    expect(text.indexOf("failed")).toBeLessThan(text.indexOf("verified"));
  });

  it("says a row was written but not read back, rather than calling it done", () => {
    const text = describeRun(summariseRun([row("APPLIED")], null));

    expect(text).toContain("not read back");
  });

  it("mentions rows still to run", () => {
    expect(describeRun(summariseRun([row("PENDING")], null))).toContain("still to run");
  });

  it("says plainly when a clean run needed no changes for some rows", () => {
    const text = describeRun(summariseRun([row("VERIFIED"), row("SKIPPED")], null));

    expect(text).toContain("needed no change");
    expect(text).not.toContain("failed");
  });

  it("says a run that wrote nothing wrote nothing, in words", () => {
    // Seen on a real abandoned run: "1020 still to run. 0 prices changed and verified."
    // Accurate, and reads like a template that failed to fill in.
    const text = describeRun(summariseRun([row("PENDING"), row("PENDING")], null));

    expect(text).toContain("Nothing has been written");
    expect(text).not.toContain("0 prices");
  });

  it("counts clamped rows as changed, because they were", () => {
    expect(describeRun(summariseRun([row("CLAMPED")], null))).toContain("1 price changed");
  });

  it("uses singular and plural correctly", () => {
    expect(describeRun(summariseRun([row("VERIFIED")], null))).toContain("1 price changed");
    expect(describeRun(summariseRun([row("VERIFIED"), row("VERIFIED", { title: "b" })], null)))
      .toContain("2 prices changed");
    expect(describeRun(summariseRun([row("FAILED")], null))).toContain("1 row failed");
    expect(describeRun(summariseRun([row("FAILED"), row("FAILED", { title: "b" })], null)))
      .toContain("2 rows failed");
  });
});

describe("naming the products that went wrong", () => {
  it("names rows that end up below the target margin", () => {
    // 10.00 → 6.00 on a 5.00 cost is a 16.7% margin.
    const result = summariseRun([row("VERIFIED", { afterMinor: 600n })], 30);

    expect(result.margin.belowTarget).toHaveLength(1);
    expect(result.margin.belowTarget[0]!.after).toBeCloseTo(16.67, 1);
  });

  it("names rows that end up at or below cost", () => {
    const result = summariseRun([row("VERIFIED", { afterMinor: 400n })], null);

    expect(result.margin.belowCost).toHaveLength(1);
  });

  it("says nothing about a target when the store has not set one", () => {
    expect(summariseRun([row("VERIFIED", { afterMinor: 600n })], null).margin.belowTarget)
      .toHaveLength(0);
  });
});

describe("tallying a database aggregate", () => {
  // The service hands over grouped counts rather than rows, because a run can be larger
  // than anything worth loading. Same classification, different input shape.
  it("adds up counts rather than counting entries", () => {
    const counts = tallyStatuses([
      { status: "VERIFIED", count: 4_000 },
      { status: "SKIPPED", count: 120 },
      { status: "FAILED", count: 3 },
    ]);

    expect(counts.verified).toBe(4_000);
    expect(counts.skipped).toBe(120);
    expect(counts.failed).toBe(3);
    expect(counts.total).toBe(4_123);
  });

  it("agrees with the row-walking path on the same data", () => {
    // The whole point of sharing this function: the aggregate and the rows must never
    // put the same status in different buckets.
    const statuses = ["VERIFIED", "VERIFIED", "CLAMPED", "REVERTED", "FAILED", "WHAT_IS_THIS"];
    const fromRows = summariseRun(statuses.map((status) => row(status)), null).counts;
    const fromAggregate = tallyStatuses(statuses.map((status) => ({ status, count: 1 })));

    expect(fromAggregate).toEqual(fromRows);
  });

  it("puts an unrecognised status where it cannot make a run look finished", () => {
    const counts = tallyStatuses([{ status: "SOMETHING_NEW", count: 7 }]);

    expect(counts.pending).toBe(7);
    expect(counts.total).toBe(7);
  });

  it("counts nothing as nothing", () => {
    expect(tallyStatuses([]).total).toBe(0);
  });
});
