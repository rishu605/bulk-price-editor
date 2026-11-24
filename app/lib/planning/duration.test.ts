/**
 * A duration a merchant can check, without a rate limit we have not observed.
 *
 * NA says "a price change job like this usually takes a minute or less" before you
 * confirm, and it is one of the more reassuring things in their app. Rule 8 says never
 * hardcode a rate limit — shops differ by plan, and the real numbers come from
 * `extensions.cost.throttleStatus` on live responses — so the temptation this guards
 * against is a confident number derived from a constant somebody assumed.
 *
 * The two honest claims are: a sync run is *defined* as one that fits the ceiling
 * `selectWritePath` enforces, and a bulk run's dominant term is a queue we cannot see.
 */

import { describe, expect, it } from "vitest";

import { describeRunDuration } from "./duration";

describe("what it is willing to claim", () => {
  it("promises the wait only for a run the page writes itself: fifty variants or fewer (D29)", () => {
    expect(describeRunDuration("sync", 50)).toContain("while you wait");
    expect(describeRunDuration("sync", 51)).not.toContain("while you wait");
  });

  it("says a larger run goes to the background, and promises no duration for it", () => {
    // "190 variants, written while you wait. A run this size is kept under 60 seconds" was on
    // Black Friday 2026's Preview tab on 24 Nov, over a run the worker writes since #808.
    const text = describeRunDuration("sync", 400);

    expect(text).toContain("400 variants");
    expect(text).toContain("in the background");
    expect(text).toContain("leave this page");
    expect(text).not.toMatch(/\d+\s*(seconds|minutes)/);
  });

  it("decides by the campaign's scope, not only what it writes", () => {
    // Forty prices to write over a scope of sixty is still the worker's run.
    expect(describeRunDuration("sync", 40, 60)).toContain("in the background");
    expect(describeRunDuration("sync", 40, 60)).not.toContain("while you wait");
  });

  it("does not put a number on the bulk queue", () => {
    const text = describeRunDuration("bulk", 50_000);

    expect(text).toContain("queue");
    expect(text, "the queue is shared and not ours to see").toContain("cannot see");
  });

  it("says the run survives leaving the page, because bulk runs outlive it", () => {
    expect(describeRunDuration("bulk", 50_000)).toContain("leave this page");
  });

  it("never states a points-per-second rate", () => {
    // The specific failure rule 8 exists to prevent: a plan's limit written down as
    // though it were true of every shop.
    for (const path of ["sync", "bulk"] as const) {
      const text = describeRunDuration(path, 5_000);

      expect(text).not.toMatch(/points?\s*(\/|per)\s*second/i);
      expect(text).not.toMatch(/\b(50|100|1000)\s*points/i);
    }
  });
});

describe("in the merchant's words, not the engine's (#759)", () => {
  it("says how long and whether it goes to the background, without naming a write path", () => {
    // The Preview tab read "Write path: sync — 2 rows is under the 1000-row threshold and
    // fits the available rate-limit budget; sync avoids bulk queue latency." This sentence
    // replaces it there, so it may not carry the same vocabulary.
    for (const [path, rows] of [["sync", 2], ["sync", 1_000], ["bulk", 50_000]] as const) {
      const text = describeRunDuration(path, rows);

      expect(text).not.toMatch(/\b(sync|bulk|threshold|rate-limit|budget|write path|latency)\b/i);
    }
    expect(describeRunDuration("sync", 2)).toContain("while you wait");
    expect(describeRunDuration("sync", 2)).toContain("in the background");
    expect(describeRunDuration("bulk", 50_000)).toContain("in the background");
  });
});

describe("the number the merchant is actually checking", () => {
  it("groups the count, because 3669 and 36690 are one glance apart", () => {
    expect(describeRunDuration("bulk", 3669)).toContain("3,669");
  });

  it("says variant, not variants, for one", () => {
    expect(describeRunDuration("sync", 1)).toContain("1 variant,");
  });

  it("says nothing would be written when nothing would", () => {
    // Not "0 variants in under 60 seconds", which reads as a run that is about to happen.
    expect(describeRunDuration("sync", 0)).toBe("Nothing would be written.");
    expect(describeRunDuration("none", 0)).toBe("Nothing would be written.");
  });
});
