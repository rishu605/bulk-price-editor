/**
 * What the drill claims it proved.
 *
 * The drill itself needs a store; its verdict does not, and the verdict is where a drill
 * usually goes wrong — by reporting success for something it never observed. A run that
 * corrupts three thousand rows, samples four hundred, finds none, and prints PASS is a
 * drill that has proved the opposite of what it says.
 */

import { describe, expect, it } from "vitest";

import { verdict, type DrillResult } from "./drill-mirror";

const result = (over: Partial<DrillResult> = {}): DrillResult => ({
  corrupted: 3_000,
  checked: 400,
  diverged: 15,
  healed: 15,
  ratePercent: 3.75,
  alerted: true,
  restored: 2_985,
  ...over,
});

describe("detection", () => {
  it("passes when the sample found divergence", () => {
    expect(verdict(result())[0]).toMatch(/^PASS.*detected 15 of 400/);
  });

  it("fails when it corrupted rows and found none", () => {
    // The first version of this drill did exactly that — corrupted 20 rows out of
    // 102,132 and sampled 20, which will essentially never intersect. It looked like a
    // broken audit and was a broken drill.
    const line = verdict(result({ diverged: 0, healed: 0, ratePercent: 0, alerted: false }))[0]!;

    expect(line).toMatch(/^FAIL/);
    expect(line).toContain("having corrupted 3000");
  });
});

describe("healing", () => {
  it("passes when everything found was healed", () => {
    expect(verdict(result())[1]).toMatch(/^PASS.*healed all 15/);
  });

  it("fails when it healed less than it found", () => {
    expect(verdict(result({ healed: 9 }))[1]).toMatch(/^FAIL.*found 15 but healed 9/);
  });

  it("does not call healing nothing a success", () => {
    // 0 healed of 0 found is arithmetically equal and proves nothing.
    expect(verdict(result({ diverged: 0, healed: 0 }))[1]).toMatch(/^FAIL/);
  });
});

describe("alerting", () => {
  it("passes when divergence above the threshold alerted", () => {
    expect(verdict(result())[2]).toMatch(/^PASS.*3\.75%/);
  });

  it("fails when it did not", () => {
    expect(verdict(result({ alerted: false }))[2]).toMatch(/^FAIL.*did not raise an alert/);
  });
});

describe("cleaning up after itself", () => {
  it("always says how many rows it put back", () => {
    // A drill that leaves damage behind is worse than no drill, and the rows it does not
    // heal are by definition the ones nobody is watching.
    expect(verdict(result()).join(" ")).toContain("restored 2985 rows");
    expect(verdict(result({ restored: 0 })).join(" ")).toContain("restored 0 rows");
  });
});
